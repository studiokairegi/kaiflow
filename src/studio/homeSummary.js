// Pure helpers for the department/freelancer home screen (no React, easy to test).
const CLOSED_LEAD_STAGES = new Set(["won", "lost", "no_response", "disqualified", "closed"]);

export const humanizeStage = (stage) => String(stage || "No stage").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

export function summarizeHome({ leads = [], cards = [], projects = [], teamMemberId = "", todayIso = new Date().toISOString().slice(0, 10) } = {}) {
  const openLeads = leads.filter((lead) => !lead.archivedAt && !CLOSED_LEAD_STAGES.has(String(lead.stage || "").toLowerCase()));
  const followupsDue = openLeads.filter((lead) => lead.followupDate && String(lead.followupDate).slice(0, 10) <= todayIso);
  const weekAgo = new Date(`${todayIso}T00:00:00Z`).getTime() - 7 * 86400000;
  const newThisWeek = leads.filter((lead) => lead.createdAt && new Date(lead.createdAt).getTime() >= weekAgo);
  const activeProjects = projects.filter((project) => !project.archived);
  const mine = teamMemberId ? cards.filter((card) => String(card.assignedMemberId || "") === String(teamMemberId)) : [];
  const openMine = mine.filter((card) => String(card.stage || "").toLowerCase() !== "delivered");
  const byStage = new Map();
  for (const card of openMine) byStage.set(card.stage, (byStage.get(card.stage) || 0) + 1);
  return {
    crm: { open: openLeads.length, followupsDue: followupsDue.length, newThisWeek: newThisWeek.length, dueLeads: followupsDue.slice(0, 5) },
    work: {
      activeProjects: activeProjects.length,
      myOpenShots: openMine.length,
      myDelivered: mine.length - openMine.length,
      stages: [...byStage.entries()].map(([stage, count]) => ({ stage, label: humanizeStage(stage), count })).sort((a, b) => b.count - a.count),
      shots: openMine.slice(0, 8),
    },
  };
}
