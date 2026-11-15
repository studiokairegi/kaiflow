"""End-to-end acceptance run for controller.py: starts the REAL controller on 127.0.0.1:17843 with a fake worker package and checks the
documented behaviour (auth, origin/host guards, backoff, exit 2 / 73, stop, shutdown, SIGTERM). POSIX only (uses SIGKILL/SIGTERM); needs port
17843 free; takes about 2 minutes. Run:  python scripts/controller_acceptance.py   (from intelligence-worker/)
"""
import os,sys,subprocess,tempfile,time,http.client,json,signal,textwrap
CTL=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"controller.py"); TOK="T"*44; ORI="https://app.studiokairegi.com"
res=[]
def check(name,ok,info=""): res.append(bool(ok)); print(("PASS " if ok else "FAIL ")+name+(("  -> "+str(info)) if info!="" else ""))
def mk():
    d=tempfile.mkdtemp(); os.makedirs(d+"/w/kairflow_intel")
    open(d+"/w/kairflow_intel/__main__.py","w").write(textwrap.dedent('''
        import os,sys,time,signal
        mode=open(os.environ["MODEFILE"]).read().strip()
        open(os.environ["MODEFILE"]+".seen","a").write(mode+"\\n")
        print("early-output-"+mode,flush=True)
        if mode=="env":
            open(os.environ["MODEFILE"]+".env","w").write(repr({k:os.environ.get(k) for k in ("PYTHONPATH","PYTHONHOME","PYTHONNOUSERSITE","KAIRFLOW_WORKER_LOG_FILE","FROM_ENVFILE","KAIRFLOW_OLLAMA_URL")}))
        if mode=="crash": sys.exit(1)
        if mode=="exit2": sys.exit(2)
        if mode=="exit73": sys.exit(73)
        if mode=="ignoreterm": signal.signal(signal.SIGTERM,signal.SIG_IGN)
        time.sleep(600)
    '''))
    open(d+"/mode","w").write("sleep"); open(d+"/t","w").write(TOK)
    open(d+"/e","w").write(f"FROM_ENVFILE=yes\nMODEFILE={d}/mode\nPYTHONPATH=/evil\n")
    return d
def launch(d,fast=False,auto=True,extra_env=None):
    wrapper=d+"/run.py"
    pre="import controller as c\n"
    if fast: pre+="c.RESTART_DELAYS=(1,2,3);c.CONFIG_ERROR_DELAY=5;c.STABLE_SECONDS=4\n"
    open(wrapper,"w").write("import sys;sys.path.insert(0,%r);sys.argv=%r\n%sraise SystemExit(c.main())\n"%(os.path.dirname(CTL),
      ["c","--worker-dir",d+"/w","--env-file",d+"/e","--python",sys.executable,"--log-file",d+"/l","--token-file",d+"/t"]+(["--auto-start"] if auto else []),pre))
    env=dict(os.environ,PYTHONPATH="/parent-evil",PYTHONHOME="" ); env.pop("PYTHONHOME")
    p=subprocess.Popen([sys.executable,wrapper],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,env=env)
    for _ in range(50):
        try: req("GET","/api/status"); return p
        except Exception: time.sleep(.1)
    return p
H={"Origin":ORI,"Authorization":"Bearer "+TOK,"Content-Type":"application/json"}
def req(m,path,h=H,body=None,host=None):
    h=dict(h);
    if host: h["Host"]=host
    c=http.client.HTTPConnection("127.0.0.1",17843,timeout=20); c.request(m,path,body=(body if body is not None else ("{}" if m=="POST" else None)),headers=h); r=c.getresponse(); raw=r.read(); hd=dict(r.getheaders()); c.close()
    return r.status,(json.loads(raw) if raw else {}),hd
def st(): return req("GET","/api/status")[1]
def wait(f,t=20):
    e=time.time()+t
    while time.time()<e:
        v=f()
        if v: return v
        time.sleep(.25)
    return None
def stop_ctl(p):
    try: req("POST","/api/shutdown")
    except Exception: pass
    try: p.wait(15)
    except Exception: p.kill()
    time.sleep(.5)

# ---- A: real constants, auto-start, env, log, first crash backoff
d=mk(); p=launch(d)
s=st(); check("auto-start launches the worker",s["worker_running"] and s["worker_pid"],s["worker_pid"])
check("status exposes documented fields",all(k in s for k in("controller_version","worker_running","restart_count","consecutive_failures","next_restart_seconds","last_exit_code","last_error")))
envd=None
open(d+"/mode","w").write("env"); req("POST","/api/stop"); req("POST","/api/start"); time.sleep(1.5)
envd=eval(open(d+"/mode.env").read()) if os.path.exists(d+"/mode.env") else {}
check("worker.env values reach the worker",envd.get("FROM_ENVFILE")=="yes")
check("PYTHONPATH from parent AND worker.env stripped",envd.get("PYTHONPATH") is None,envd.get("PYTHONPATH"))
check("PYTHONNOUSERSITE=1 and log file path injected",envd.get("PYTHONNOUSERSITE")=="1" and envd.get("KAIRFLOW_WORKER_LOG_FILE")==d+"/l")
check("early worker output captured in worker.log","early-output-env" in open(d+"/l").read())
check("secrets/token never in status",TOK not in json.dumps(st()) and "evil" not in json.dumps(st()))
open(d+"/mode","w").write("crash"); req("POST","/api/stop"); req("POST","/api/start")
s=wait(lambda: (lambda x: x if (not x["worker_running"] and x["next_restart_seconds"] is not None) else None)(st()),10)
check("first crash: restart scheduled in 20 s (real constants)",s and 17<=s["next_restart_seconds"]<=20 and s["consecutive_failures"]==1,s and (s["next_restart_seconds"],s["consecutive_failures"]))
check("crash message reported",s and "unexpectedly (exit 1)" in (s["last_error"] or ""))
s=req("POST","/api/stop")[1]
time.sleep(3)
s2=st()
check("manual Stop during backoff: no restart, state cleared",not s2["worker_running"] and s2["next_restart_seconds"] is None and s2["last_error"] is None and s2["consecutive_failures"]==0)
stop_ctl(p)

# ---- B: HTTP security / protocol
d=mk(); p=launch(d,auto=False)
check("no auto-start without --auto-start",not st()["worker_running"])
check("no token -> 401",req("GET","/api/status",h={"Origin":ORI})[0]==401)
check("wrong token -> 401",req("GET","/api/status",h={"Origin":ORI,"Authorization":"Bearer "+"B"*44})[0]==401)
check("foreign origin -> 403",req("GET","/api/status",h={"Origin":"https://evil.example","Authorization":"Bearer "+TOK})[0]==403)
check("no origin -> 403",req("GET","/api/status",h={"Authorization":"Bearer "+TOK})[0]==403)
check("bad Host header (DNS rebinding) -> 403",req("GET","/api/status",host="evil.example:17843")[0]==403)
check("non-JSON POST -> 415",req("POST","/api/start",h={**H,"Content-Type":"text/plain"})[0]==415)
check("oversized POST -> 413",req("POST","/api/start",body="x"*2000)[0]==413)
check("unknown path -> 404",req("GET","/api/nope")[0]==404 and req("POST","/api/nope")[0]==404)
code,_,hd=req("OPTIONS","/api/start",h={"Origin":ORI,"Access-Control-Request-Private-Network":"true"})
check("CORS preflight incl. Private Network Access",code==204 and hd.get("Access-Control-Allow-Origin")==ORI and hd.get("Access-Control-Allow-Private-Network")=="true")
check("non-ASCII bearer -> clean 401 (no dropped connection)",req("GET","/api/status",h={"Origin":ORI,"Authorization":"Bearer "+"é"*44})[0]==401)
open(d+"/e","a").write("KAIRFLOW_OLLAMA_URL=http://10.1.2.3:11434\n")
c,b,_=req("POST","/api/start"); check("remote Ollama URL refused on Start",c==400 and "this computer" in b.get("error",""),c)
check("failed Start leaves no phantom state",not st()["worker_running"] and st()["next_restart_seconds"] is None)
open(d+"/e","w").write(f"MODEFILE={d}/mode\nKAIRFLOW_OLLAMA_URL=\n")
c,b,_=req("POST","/api/start"); check("blank Ollama URL accepted; Start works",c==200 and b["worker_running"],c)
check("Start twice is idempotent (same PID)",req("POST","/api/start")[1]["worker_pid"]==b["worker_pid"])
stop_ctl(p)

# ---- C: fast constants: escalation, exit 2, exit 73, stable reset, hung worker, auto-start waits for env
d=mk(); open(d+"/mode","w").write("crash"); p=launch(d,fast=True)
seen=[]
e=time.time()+25
while time.time()<e and len(seen)<4:
    s=st()
    if s["next_restart_seconds"] is not None and (not seen or seen[-1]!=s["consecutive_failures"]): seen.append(s["consecutive_failures"])
    time.sleep(.3)
check("consecutive failures escalate on repeated crashes",seen[:3]==[1,2,3],seen)
c=ctl_delays=None
import importlib.util
sp=importlib.util.spec_from_file_location("cc",CTL); cc=importlib.util.module_from_spec(sp); sp.loader.exec_module(cc)
check("documented schedule 20,40,80,160,320,600 then capped; exit 2 >= 300",[cc.restart_delay(n,1) for n in range(1,8)]==[20,40,80,160,320,600,600] and cc.restart_delay(1,2)==300 and cc.restart_delay(6,2)==600)
open(d+"/mode","w").write("exit2"); req("POST","/api/stop"); req("POST","/api/start")
s=wait(lambda: (lambda x: x if x["last_exit_code"]==2 and x["next_restart_seconds"] is not None else None)(st()),8)
check("exit 2 reported as configuration error, delayed >= CONFIG_ERROR_DELAY",s and "configuration error" in s["last_error"] and s["next_restart_seconds"]>=3,s and s["next_restart_seconds"])
open(d+"/mode","w").write("exit73"); req("POST","/api/stop"); req("POST","/api/start")
s=wait(lambda: (lambda x: x if x["duplicate_worker_detected"] else None)(st()),8)
time.sleep(5); s2=st()
check("exit 73: flagged duplicate, NOT restarted",s and s2["duplicate_worker_detected"] and not s2["worker_running"] and s2["next_restart_seconds"] is None)
n=len(open(d+"/mode.seen").read().split())
open(d+"/mode","w").write("sleep"); req("POST","/api/start")
time.sleep(1); check("explicit Start recovers after duplicate",st()["worker_running"])
time.sleep(1); os.kill(st()["worker_pid"],signal.SIGKILL)   # crash after being up <STABLE
s=wait(lambda: (lambda x: x if not x["worker_running"] and x["consecutive_failures"] else None)(st()),8)
check("worker killed externally is restarted",wait(lambda: st()["worker_running"],12) is not None)
time.sleep(5)  # exceed STABLE_SECONDS
os.kill(st()["worker_pid"],signal.SIGKILL); s=wait(lambda: (lambda x: x if not x["worker_running"] and x["consecutive_failures"] else None)(st()),8)
check("run that stayed up >= STABLE_SECONDS resets streak to 1",s and s["consecutive_failures"]==1,s and s["consecutive_failures"])
wait(lambda: st()["worker_running"],12)
open(d+"/mode","w").write("ignoreterm"); req("POST","/api/stop"); req("POST","/api/start"); time.sleep(1)
t=time.time(); r=req("POST","/api/stop")[1]; el=time.time()-t
check("worker ignoring SIGTERM is force-killed (~8 s) and Stop reports stopped",not r["worker_running"] and 7<=el<=12,round(el,1))
stop_ctl(p)

# ---- D: auto-start retries until worker.env exists; shutdown exits 0 and stops worker; SIGTERM
d=mk(); os.rename(d+"/e",d+"/e.hold"); p=launch(d,fast=True)
s=st(); check("auto-start with missing worker.env keeps retrying (not running, error shown)",not s["worker_running"] and "settings file not found" in (s["last_error"] or ""))
os.rename(d+"/e.hold",d+"/e")
check("worker starts by itself once worker.env appears",wait(lambda: st()["worker_running"],45) is not None)
pid=st()["worker_pid"]; c,b,_=req("POST","/api/shutdown")
check("shutdown replies controller_exiting and stops worker",c==200 and b["controller_exiting"] and not b["worker_running"])
try: rc=p.wait(10)
except Exception: rc=None
check("controller process exits with code 0",rc==0,rc)
try: os.kill(pid,0); alive=True
except OSError: alive=False
check("worker gone after shutdown",not alive)
d=mk(); p=launch(d); pid=st()["worker_pid"]; p.send_signal(signal.SIGTERM)
try: rc=p.wait(12)
except Exception: rc=None; p.kill()
time.sleep(.5)
try: os.kill(pid,0); alive=True
except OSError: alive=False
check("SIGTERM to controller stops the worker too",rc==0 and not alive,(rc,alive))
print(f"\n{sum(res)}/{len(res)} checks passed")
