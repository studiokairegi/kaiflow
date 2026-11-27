import React from "react";
import { Banner, useFinance } from "./kit.jsx";
import { friendlyError } from "./errors.js";
export default function ModeSwitch() {
  const { mode, setMode, saveErr } = useFinance();
  return (<div className="stack" style={{ gap: 6 }}><div className="mode" role="group" aria-label="Finance view">
    <button type="button" aria-pressed={mode !== "accountant"} onClick={() => setMode("simple")}>Simple</button>
    <button type="button" aria-pressed={mode === "accountant"} onClick={() => setMode("accountant")}>Accountant</button></div>
    {saveErr && <Banner tone="warning">Your view choice could not be saved: {friendlyError(saveErr)}</Banner>}</div>);
}
