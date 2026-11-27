import React, { useState } from "react";
import { Banner, Button, useFinance } from "../shared/kit.jsx";
import HeaderTools from "../shared/Notifications.jsx";
import Home from "./Home.jsx";
import Invoices from "./Invoices.jsx";
import Payments from "./Payments.jsx";
import Projects from "./Projects.jsx";

const SECTIONS = [["home", "Home"], ["invoices", "Invoices"], ["payments", "Payments"], ["projects", "Projects"]];
export default function SimpleMode() {
  const { can } = useFinance();
  const [section, setSection] = useState("home"); const [openInvoice, setOpenInvoice] = useState(null);
  const go = (s, inv = null) => { setSection(s); setOpenInvoice(inv); };
  if (!can("finance.read")) return <Banner tone="info" title="Finance is not open to your role.">Ask a finance admin if you need access.</Banner>;
  return (<div className="stack">
    <div className="head"><div><h1>Finance</h1><p className="sub">Simple view: the money that matters, in plain words.</p></div><HeaderTools /></div>
    <nav className="navgroup" aria-label="Finance sections">{SECTIONS.map(([id, l]) => <button key={id} type="button" className="chip" aria-current={section === id ? "page" : undefined} onClick={() => go(id)}>{l}</button>)}</nav>
    <main id="fin-main">
      {section === "home" && <Home go={go} />}
      {section === "invoices" && <Invoices openId={openInvoice} />}
      {section === "payments" && <Payments go={go} />}
      {section === "projects" && <Projects />}
    </main></div>);
}
