import React, { useMemo } from "react";
import { describeAccess } from "./access.js";
import { summarizeHome } from "./homeSummary.js";
import "./departmentHome.css";

// Dedicated home for department members and freelancers: only what their login can open,
// never the studio-wide finance / payments dashboard.
export default function DepartmentHome({
  studioAccess, workspaces = [], leads = [], cards = [], projects = [],
  onGoTo, onOpenLead, onOpenShot,
}) {
  const departmentName = (studioAccess?.department_names || [])[0] || "";
  const name = String(studioAccess?.display_name || "").trim().split(/\s+/)[0] || "there";
  const summary = useMemo(
    () => summarizeHome({ leads, cards, projects, teamMemberId: studioAccess?.team_member_id || "" }),
    [leads, cards, projects, studioAccess?.team_member_id],
  );
  const showCrm = workspaces.includes("leads");
  const showWork = workspaces.includes("projects");
  const projectName = (card) => projects.find((project) => project.id === card.projectId)?.name || "";

  return (
    <div className="kf-home">
      <section className="kf-home-hero">
        <div>
          <h2>Hi {name}</h2>
          <p>{studioAccess?.organization_name ? `${studioAccess.organization_name} · ` : ""}{describeAccess(studioAccess?.role, departmentName)}</p>
        </div>
        <p className="kf-home-tip">Need a teammate? Use the chat button at the bottom right.</p>
      </section>

      {showCrm && (
        <section className="kf-home-card" aria-label="CRM snapshot">
          <header><strong>CRM</strong><button type="button" onClick={() => onGoTo?.("leads")}>Open CRM</button></header>
          <div className="kf-home-stats">
            <div><b>{summary.crm.open}</b><span>Open leads</span></div>
            <div className={summary.crm.followupsDue ? "warn" : ""}><b>{summary.crm.followupsDue}</b><span>Follow-ups due</span></div>
            <div><b>{summary.crm.newThisWeek}</b><span>New this week</span></div>
          </div>
          {summary.crm.dueLeads.length > 0 && <ul className="kf-home-list">
            {summary.crm.dueLeads.map((lead) => (
              <li key={lead.id}><button type="button" onClick={() => onOpenLead?.(lead)}>
                <span>{lead.companyName || "Untitled lead"}</span><small>Follow up {String(lead.followupDate).slice(0, 10)}</small>
              </button></li>
            ))}
          </ul>}
        </section>
      )}

      {showWork && (
        <section className="kf-home-card" aria-label="My work">
          <header><strong>My shots</strong><button type="button" onClick={() => onGoTo?.("projects")}>Open projects</button></header>
          <div className="kf-home-stats">
            <div><b>{summary.work.myOpenShots}</b><span>Assigned to me</span></div>
            <div><b>{summary.work.myDelivered}</b><span>Delivered</span></div>
            <div><b>{summary.work.activeProjects}</b><span>Projects</span></div>
          </div>
          {summary.work.shots.length > 0 ? <ul className="kf-home-list">
            {summary.work.shots.map((card) => (
              <li key={card.id}><button type="button" onClick={() => onOpenShot?.(card)}>
                <span>{card.title || "Untitled shot"}</span>
                <small>{[projectName(card), summary.work.stages.find((s) => s.stage === card.stage)?.label].filter(Boolean).join(" · ")}</small>
              </button></li>
            ))}
          </ul> : <p className="kf-home-empty">Nothing is assigned to you right now. New shots will show up here.</p>}
        </section>
      )}

      {!showCrm && !showWork && (
        <section className="kf-home-card"><p className="kf-home-empty">Your studio hasn’t opened any modules for you yet. You can still use chat and your settings.</p></section>
      )}
    </div>
  );
}
