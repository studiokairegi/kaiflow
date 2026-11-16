# The Emma switch (no command prompt needed)

## Using it
Open **Intelligence > Overview** (small switch at the top) or **Intelligence > Settings > Emma** (large switch).

| You see | What it means | Clicking the switch |
|---|---|---|
| Emma is on (green) | Worker and controller are running | Turns **everything off**: stops the worker and the controller. Asks you to confirm. Nothing is lost; queued work waits |
| Emma is paused | Controller is running, worker is stopped | Starts the worker |
| Emma is fully off | Nothing is running | Starts the controller, which starts the worker (up to a minute) |
| This browser is not paired yet | One-time pairing missing | Paste the controller token in Settings once |

Settings > Emma also has "Advanced: pause or resume the worker only" for the old Start/Stop Emma buttons.

## One-time setup (do once per computer)
- **Already installed the controller?** Double-click `intelligence-worker\windows\Install-Emma-Switch.cmd`. It registers a private link so the switch can turn Emma back on. Your browser may ask to open the link once: choose **Always allow**.
- **Installing fresh?** `install-controller.ps1` now does this step for you.
- Remove it any time with `uninstall-launcher.ps1`. The switch then still pauses and resumes Emma while the controller runs, but cannot restart a fully stopped controller.

## What it can and cannot do
- It never touches the emergency stop or sending settings. Turning Emma on does not enable sending; if sending is enabled and the emergency stop is off, approved messages follow your existing limits (the confirmation says so).
- A web page cannot start a program that is not running. That is why the "on" step uses the `kairflow-emma:` link, which can only start the already-installed controller task and reads nothing from the page.
- Turning off from a different computer is not possible: the controller only listens on this computer.

## Known limits (by design, worth knowing)
- The `kairflow-emma:` link is registered for your Windows user, so any web page could ask your browser to open it. Your browser asks first for each website; once you choose "Always allow" for KairFlow, only KairFlow is exempt. If a page did trigger it, the worst case is that the controller (and Emma) start. They cannot send anything the emergency stop, approval and limit settings do not allow. If you ever want Emma to stay off no matter what, run `uninstall-launcher.ps1`.
- The switch shows "controller reported a problem" (not "paused") if the controller answers with an error, for example when `worker.env` is incomplete.

## Not yet verified (needs one check on your Windows machine)
1. After "off", Windows must NOT relaunch the controller by itself. The controller exits normally (code 0), and Task Scheduler restarts only failed runs, so it should stay off until you switch it on or sign in again. If you see it come back on its own within a couple of minutes, tell me; the fix is a task setting.
2. Your browser must allow the `kairflow-emma:` link. If "Turn on" times out, run Install-Emma-Switch.cmd and retry.
3. The tests cover the switch logic and the controller's shutdown endpoint (a real local server with a fake worker). They do not cover Windows, Task Scheduler or the browser prompt.
