// Freelancer deliverables are transferred browser -> Google Drive via resumable sessions.
// The per-shot share token remains the capability credential; Drive credentials stay server-side.
// POST JSON actions: init-upload, finalize, recover-upload. Deployed with --no-verify-jwt.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { createResumableUploadSession, getCachedAccessToken, getDriveFileMeta, listFilesByAppProperty, shareFileWithAnyone } from "../_shared/google.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { CLIENT_OUTDATED_MESSAGE, FINGERPRINT_PROP, MD5_MISMATCH_MESSAGE, fingerprintMatches, freelancerMaxBytes, intFromEnv, isJsonRequest, md5Verdict, pickRecoveredFile, safeMime, validFingerprint } from "../_shared/upload_recovery.ts";
import { RATE_LIMIT_MESSAGE, markUploadSessionFinalized, registerUploadSession } from "../_shared/upload_sessions.ts";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});
const validId=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_-]{8,64}$/.test(v);
Deno.serve(async(req)=>{
 const opt=handleOptions(req);if(opt)return opt;if(req.method!=="POST")return json({error:"Method not allowed"},405);
 if(!isJsonRequest(req))return json({error:CLIENT_OUTDATED_MESSAGE,code:"client_outdated"},426);
 try{
  const body=await req.json().catch(()=>({}));const token=body.token;const action=body.action;const uploadId=body.uploadId;
  if(typeof token!=="string"||token.length<16||token.length>256)return json({error:"Missing or invalid share token."},400);
  if(!validId(uploadId))return json({error:"Missing or invalid upload id."},400);
  const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const {data:shot,error:shotError}=await db.from("shots").select("id,project_id,user_id,title,stage,assigned_to,drive_deliverables_folder_id").eq("share_token",token).maybeSingle();
  if(shotError||!shot)return json({error:"This link isn't valid."},404);
  let reviewWorkflowEnabled=false;
  const {data:wf,error:wfError}=await db.from("shots").select("workflow_state").eq("id",shot.id).maybeSingle();
  if(!wfError&&wf){reviewWorkflowEnabled=true;if(!["in_progress","pending_review"].includes(wf.workflow_state))return json({error:"This cut isn't accepting new submissions right now. Please check with the studio."},409);}
  let folderId=shot.drive_deliverables_folder_id||null;
  if(!folderId){const {data:project,error}=await db.from("projects").select("drive_deliverables_folder_id").eq("id",shot.project_id).maybeSingle();if(error)return json({error:"Unable to determine the project's Drive folder."},500);folderId=project?.drive_deliverables_folder_id||null;}
  if(!folderId)return json({error:"not_connected",message:"This project isn't set up with a Deliverables Drive folder yet."},400);
  const {data:connection,error:connError}=await db.from("google_drive_connections").select("refresh_token_encrypted").eq("user_id",shot.user_id).maybeSingle();
  if(connError||!connection)return json({error:"not_connected",message:"The studio's Drive connection is missing."},400);
  // Google access token is resolved lazily and cached per isolate: only actions that touch Drive pay for it, and not once per request.
  let accessPromise:Promise<string>|null=null;
  const getAccess=()=>accessPromise??=(async()=>getCachedAccessToken(await decryptText(connection.refresh_token_encrypted,Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!)))();
  if(action==="init-upload"){
   const name=body.name;const size=Number(body.size);const mime=safeMime(body.mimeType);
   if(typeof name!=="string"||!name.trim()||name.length>200||!Number.isSafeInteger(size)||size<=0)return json({error:"Choose a valid, non-empty file (maximum filename length 200 characters)."},400);
   const maxBytes=freelancerMaxBytes(Deno.env.get("FREELANCER_UPLOAD_MAX_BYTES"));if(size>maxBytes)return json({error:`File is too large. The limit is ${Math.floor(maxBytes/(1024*1024*1024))} GB.`,code:"file_too_large"},413);
   const cleanTitle=(shot.title||"shot").replace(/[^\w\- ]+/g,"").trim();const driveName=`${cleanTitle} - ${name}`;
   if(!validFingerprint(body.fingerprint))return json({error:"Missing file fingerprint."},400);
   // Bound how many NEW Drive sessions a share-link holder can open (per shot); re-opening an existing upload id is free.
   const gate=await registerUploadSession(db,{kind:"freelancer",uploadId,scope:`shot:${shot.id}`,userId:shot.user_id,shotId:shot.id,folderId,limit:intFromEnv(Deno.env.get("FREELANCER_UPLOAD_INITS_PER_HOUR"),20),windowSeconds:3600});
   if(!gate.allowed)return new Response(JSON.stringify({error:RATE_LIMIT_MESSAGE,code:"rate_limited"}),{status:429,headers:{...corsHeaders,"Content-Type":"application/json","Retry-After":String(gate.retryAfterSeconds)}});
   const access=await getAccess();
   const uploadUrl=await createResumableUploadSession(access,folderId,driveName,mime,size,req.headers.get("Origin")||undefined,{freelancerUpload:uploadId,[FINGERPRINT_PROP]:body.fingerprint});
   return json({uploadUrl,uploadId});
  }
  if(action!=="recover-upload"&&action!=="finalize")return json({error:"Unknown action."},400);
  const access=await getAccess();
  let fileId=typeof body.fileId==="string"?body.fileId:"";
  if(action==="recover-upload"){
   const matches=await listFilesByAppProperty(access,folderId,"freelancerUpload",uploadId);
   const picked=pickRecoveredFile(matches,body.fingerprint,Number(body.size));
   if(!picked){
    // Distinguish "different file under this id" (409) from "nothing found yet" (404, which the client retries with backoff).
    if(matches.some((m)=>!m.trashed&&!fingerprintMatches(m,body.fingerprint)))return json({error:"A different file was already uploaded under this upload id.",code:"file_mismatch"},409);
    return json({error:"The upload has not completed in Google Drive.",code:"upload_not_found"},404);
   }
   fileId=picked.id;
  }else if(action!=="finalize")return json({error:"Unknown action."},400);
  if(!/^[A-Za-z0-9_-]{10,100}$/.test(fileId))return json({error:"Missing Drive file id."},400);
  const meta=await getDriveFileMeta(access,fileId);
  if(!meta||meta.appProperties?.freelancerUpload!==uploadId)return json({error:"This Drive file does not belong to the requested freelancer upload session."},403);
  if(!fingerprintMatches(meta,body.fingerprint))return json({error:"This Drive file is not the file that was selected for this upload.",code:"file_mismatch"},409);
  // Full-content check: the fingerprint samples only part of the file; Drive's md5Checksum covers every byte.
  const verdict=md5Verdict(meta,body.md5);
  if(verdict==="required")return json({error:"A full-file checksum is required.",code:"md5_required",fileId},428);
  if(verdict==="pending")return new Response(JSON.stringify({error:"Google Drive is still processing the file. Retrying shortly.",code:"checksum_pending"}),{status:503,headers:{...corsHeaders,"Content-Type":"application/json","Retry-After":"3"}});
  if(verdict==="mismatch")return json({error:MD5_MISMATCH_MESSAGE,code:"file_mismatch"},409);
  if(meta.trashed||!meta.parents?.includes(folderId))return json({error:"The uploaded file could not be verified in the shot's Deliverables folder."},422);
  const size=Number(body.size??meta.size??0);if(!Number.isSafeInteger(size)||size<=0||Number(meta.size)!==size)return json({error:"The uploaded file size could not be verified."},422);
  // Preserve the legacy freelancer-deliverable access contract: these files are intentionally link-viewable, unlike
  // private Final QC candidate files. shareFileWithAnyone retries transient failures; the outcome is reported to the client.
  const shared=await shareFileWithAnyone(access,fileId);
  const name=typeof body.name==="string"?body.name:meta.name||"deliverable";const mime=typeof body.mimeType==="string"?safeMime(body.mimeType):meta.mimeType||null;
  // Order matters: the review submission is registered (idempotently, keyed on drive_file_id) BEFORE the deliverable is
  // appended, so a workflow-gate change in between yields 409 not_accepting with NO orphan deliverable on the shot.
  if(reviewWorkflowEnabled){const {error}=await db.rpc("register_freelancer_submission",{p_token:token,p_drive_file_id:fileId,p_name:name,p_mime:mime,p_size:size});if(error){console.error("register_freelancer_submission failed:",error.message);if((error.message||"").includes("cut_not_accepting_submissions"))return json({error:"This cut isn't accepting new submissions right now. Please check with the studio.",code:"not_accepting"},409);return json({error:"The file is safe in Drive but couldn't be submitted for review. Retry finalization; do not upload it again."},500);}}
  // Atomic + idempotent: one UPDATE ... WHERE NOT EXISTS keyed on driveFileId, so concurrent finalizations cannot both append.
  const entry={name,url:`https://drive.google.com/file/d/${fileId}/view`,driveFileId:fileId,uploadedAt:new Date().toISOString()};
  const {data:appended,error:appendError}=await db.rpc("append_shot_deliverable_once",{p_shot_id:shot.id,p_entry:entry});
  if(appendError)return json({error:"The file is safely in Drive but couldn't be linked to the shot. Retry finalization; do not upload it again."},500);
  const already=appended!==true;
  await markUploadSessionFinalized(db,"freelancer",uploadId,fileId);
  if(!already){const {error}=await db.from("activity_log").insert({user_id:shot.user_id,project_id:shot.project_id,shot_id:shot.id,event_type:"freelancer_upload",description:`${shot.assigned_to||"A freelancer"} uploaded "${name}" to Drive for ${shot.title}`});if(error)console.error("Activity log insert failed:",error.message);}
  return json({success:true,url:`https://drive.google.com/file/d/${fileId}/view`,fileId,duplicate:already,shared});
 }catch(err){const message=err instanceof Error?err.message:String(err);console.error("freelancer-drive-upload error:",message);return json({error:message},500);}
});
