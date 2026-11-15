// Final QC upload uses a browser-to-Google-Drive resumable transfer. The Edge Function
// only authorizes, creates the upload session, verifies Drive metadata, and registers it.
// POST JSON actions: init-upload, finalize, recover-upload. Upload != client release.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { createResumableUploadSession, getCachedAccessToken, getDriveFileMeta, listFilesByAppProperty } from "../_shared/google.ts";
import { ensureFinalQcFolders, cleanFolderName } from "../_shared/final_qc.ts";
import { validateFinalUploadInput, validateDriveFile } from "../_shared/final_validation.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { CLIENT_OUTDATED_MESSAGE, FINGERPRINT_PROP, MD5_MISMATCH_MESSAGE, fingerprintMatches, intFromEnv, isJsonRequest, md5Verdict, pickRecoveredFile, safeMime, validFingerprint } from "../_shared/upload_recovery.ts";
import { RATE_LIMIT_MESSAGE, markUploadSessionFinalized, registerUploadSession } from "../_shared/upload_sessions.ts";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});
const UNLOCKED_STATES=["qc_adjustments","ready_for_client","released"];
// Folder ids change rarely; resolving them costs several Drive calls, and one upload makes up to ~6 requests (init, recover polls, finalize).
// Cached per isolate for 5 minutes and dropped on any error so a deleted/moved folder is re-resolved.
const folderCache=new Map<string,{folders:{projectFolderId:string;cutFolderId:string};expiresAt:number}>();
const validKey=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_-]{8,64}$/.test(v);
Deno.serve(async(req)=>{
 const opt=handleOptions(req); if(opt)return opt; if(req.method!=="POST")return json({error:"Method not allowed"},405);
 if(!isJsonRequest(req))return json({error:CLIENT_OUTDATED_MESSAGE,code:"client_outdated"},426);
 let folderCacheKey="";
 try {
  const jwt=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/,""); if(!jwt)return json({error:"Missing Authorization header"},401);
  const auth=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!);
  const {data:{user},error:authError}=await auth.auth.getUser(jwt); if(authError||!user)return json({error:"Invalid session"},401);
  const body=await req.json().catch(()=>({})); const action=body.action;
  const shotId=body.shotId; const uploadKey=body.uploadKey;
  if(typeof shotId!=="string"||!validKey(uploadKey))return json({error:"Missing or invalid shotId/uploadKey."},400);
  const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const {data:shot,error:shotErr}=await db.from("shots").select("id,project_id,user_id,title,workflow_state,drive_final_qc_folder_id").eq("id",shotId).eq("user_id",user.id).maybeSingle();
  if(shotErr||!shot)return json({error:"That cut doesn't belong to your studio."},403);
  if(!UNLOCKED_STATES.includes(shot.workflow_state))return json({error:"Final upload unlocks after the freelancer's submission passes internal QC."},409);
  const {data:prior}=await db.from("cut_final_versions").select("id,version,validation_status").eq("shot_id",shot.id).eq("upload_key",uploadKey).maybeSingle();
  if(prior&&action==="init-upload")return json({error:"This upload key was already used. Start a new upload.",code:"upload_key_used"},409);
  if(prior)return json({success:prior.validation_status==="valid",versionId:prior.id,version:prior.version,validationStatus:prior.validation_status,duplicate:true});
  const {data:approved,error:approvedErr}=await db.from("cut_submissions").select("id").eq("shot_id",shot.id).eq("status","approved").limit(1);
  if(approvedErr)return json({error:"Couldn't verify internal QC approval."},503);
  if(!approved?.length)return json({error:"No approved internal QC submission exists for this cut."},409);
  const {data:project}=await db.from("projects").select("id,drive_folder_id,drive_final_qc_folder_id").eq("id",shot.project_id).eq("user_id",user.id).maybeSingle();
  if(!project)return json({error:"Project not found."},404);
  const {data:connection}=await db.from("google_drive_connections").select("refresh_token_encrypted").eq("user_id",user.id).maybeSingle();
  if(!connection)return json({error:"not_connected",message:"Connect Google Drive in Settings first."},400);
  // Google access token: lazy + cached per isolate (see _shared/google.ts) instead of a fresh OAuth refresh on every action.
  let accessPromise:Promise<string>|null=null;
  const getAccess=()=>accessPromise??=(async()=>getCachedAccessToken(await decryptText(connection.refresh_token_encrypted,Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!)))();
  if(action==="init-upload"){
   // Cheap, pure input validation runs before any Google call; the rate limit follows the (cached) folder lookup below.
   const name=body.name; const size=Number(body.size);
   const input=validateFinalUploadInput({name,size}); if(!input.ok)return json({error:input.error},input.status);
   if(!validFingerprint(body.fingerprint))return json({error:"Missing file fingerprint."},400);
  }
  folderCacheKey=`${user.id}:${shot.id}`;
  const cached=folderCache.get(folderCacheKey);
  let folders=cached&&cached.expiresAt>Date.now()?cached.folders:null;
  if(!folders){folders=await ensureFinalQcFolders(db,await getAccess(),project,shot);folderCache.set(folderCacheKey,{folders,expiresAt:Date.now()+5*60_000});}
  if(action==="init-upload"){
   const name=body.name; const size=Number(body.size); const mime=safeMime(body.mimeType);
   const driveName=`${cleanFolderName(shot.title,"Cut")} - FINAL - ${uploadKey.slice(0,8)} - ${name}`;
   // Bound how many NEW Drive sessions one studio account can open per hour; re-opening an existing upload key is free.
   const gate=await registerUploadSession(db,{kind:"final_qc",uploadId:uploadKey,scope:`user:${user.id}`,userId:user.id,shotId:shot.id,folderId:folders.cutFolderId,limit:intFromEnv(Deno.env.get("FINAL_QC_UPLOAD_INITS_PER_HOUR"),60),windowSeconds:3600});
   if(!gate.allowed)return new Response(JSON.stringify({error:RATE_LIMIT_MESSAGE,code:"rate_limited"}),{status:429,headers:{...corsHeaders,"Content-Type":"application/json","Retry-After":String(gate.retryAfterSeconds)}});
   const access=await getAccess();
   const uploadUrl=await createResumableUploadSession(access,folders.cutFolderId,driveName,mime,size,req.headers.get("Origin")||undefined,{finalQcUpload:uploadKey,[FINGERPRINT_PROP]:body.fingerprint});
   return json({uploadUrl,uploadKey});
  }
  if(action!=="recover-upload"&&action!=="finalize")return json({error:"Unknown action."},400);
  const access=await getAccess();
  let fileId=typeof body.fileId==="string"?body.fileId:"";
  if(action==="recover-upload"){
   const matches=await listFilesByAppProperty(access,folders.cutFolderId,"finalQcUpload",uploadKey);
   const picked=pickRecoveredFile(matches,body.fingerprint,Number(body.size));
   if(!picked){
    if(matches.some((m)=>!m.trashed&&!fingerprintMatches(m,body.fingerprint)))return json({error:"A different file was already uploaded under this upload key.",code:"file_mismatch"},409);
    return json({error:"The upload has not completed in Google Drive.",code:"upload_not_found"},404);
   }
   fileId=picked.id;
  } else if(action!=="finalize") return json({error:"Unknown action."},400);
  if(!/^[A-Za-z0-9_-]{10,100}$/.test(fileId))return json({error:"Missing Drive file id.",code:"invalid_file"},400);
  const meta=await getDriveFileMeta(access,fileId);
  if(!meta||meta.appProperties?.finalQcUpload!==uploadKey)return json({error:"This Drive file does not belong to the requested Final QC upload session."},403);
  if(!fingerprintMatches(meta,body.fingerprint))return json({error:"This Drive file is not the file that was selected for this upload.",code:"file_mismatch"},409);
  // Full-content check: the fingerprint samples only part of the file; Drive's md5Checksum covers every byte.
  const verdict=md5Verdict(meta,body.md5);
  if(verdict==="required")return json({error:"A full-file checksum is required.",code:"md5_required",fileId},428);
  if(verdict==="pending")return new Response(JSON.stringify({error:"Google Drive is still processing the file. Retrying shortly.",code:"checksum_pending"}),{status:503,headers:{...corsHeaders,"Content-Type":"application/json","Retry-After":"3"}});
  if(verdict==="mismatch")return json({error:MD5_MISMATCH_MESSAGE,code:"file_mismatch"},409);
  const expectedSize=Number(body.size??meta.size??0);
  const failure=validateDriveFile(meta,{fileId,folderId:folders.cutFolderId,sizeBytes:expectedSize});
  const name=typeof body.name==="string"?body.name:meta?.name||"final-deliverable";
  const mime=typeof body.mimeType==="string"?safeMime(body.mimeType):meta?.mimeType||null;
  const {data:rec,error:recErr}=await db.rpc("register_final_version",{p_user_id:user.id,p_shot_id:shot.id,p_upload_key:uploadKey,p_drive_file_id:fileId,p_drive_folder_id:folders.cutFolderId,p_file_name:name,p_mime:mime,p_size:expectedSize,p_valid:!failure,p_error:failure});
  if(recErr){const m=recErr.message||"";const status=m.includes("final_upload_not_unlocked")||m.includes("no_qc_approval")?409:503;return json({error:m.includes("no_qc_approval")?"No approved internal QC submission exists for this cut.":`The file is safely in Drive but registration failed: ${m}. Retry finalization; do not upload it again.`,code:"finalize_failed"},status);}
  // A rejected file is deliberately NOT marked finalized: the cleanup job trashes it once its retention window passes.
  if(failure)return json({success:false,error:failure,versionId:rec?.versionId,validationStatus:"invalid"},422);
  await markUploadSessionFinalized(db,"final_qc",uploadKey,fileId);
  return json({success:true,versionId:rec.versionId,version:rec.version,validationStatus:"valid",duplicate:!!rec.duplicate});
 }catch(err){if(folderCacheKey)folderCache.delete(folderCacheKey);const message=err instanceof Error?err.message:String(err);console.error("final-qc-upload error:",message);return json({error:message},500);}
});
