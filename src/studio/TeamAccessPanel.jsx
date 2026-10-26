import React, { useCallback, useEffect, useMemo, useState } from "react";
import { chatApi } from "../chat/api.js";
import { buildInviteLink, createInviteToken, describeAccess, inviteRoleFor } from "./access.js";
import "./teamAccess.css";

// People stay in Teams: the roster is the only place people are added. This module only
// adds a small "access" control to each roster card (invite link, department, pause) and a
// Departments drawer. No separate onboarding screen.

const MODULE_ACCESS = [
  { id: "crm", label: "CRM & contacts", view: ["crm.read", "contacts.read"], edit: ["crm.write", "contacts.write"] },
  { id: "projects", label: "Projects & shots", view: ["projects.read", "shots.read", "activity.read"], edit: ["projects.write", "shots.write"] },
  { id: "teams", label: "Teams roster", view: ["teams.read"], edit: ["teams.write"] },
];

export function levelFor(rows, group) {
  const keys = new Set((rows || []).map((row) => row.permission_key));
  if (group.edit.every((key) => keys.has(key))) return "edit";
  if (group.view.some((key) => keys.has(key))) return "view";
  return "none";
}

export function keysForLevel(group, level) {
  if (level === "edit") return [...group.view, ...group.edit];
  if (level === "view") return [...group.view];
  return [];
}

export function readableError(error) {
  const message = String(error?.message || "");
  if (/team_member_already_linked/i.test(message)) return "This person already has a login.";
  if (/team_member_not_found/i.test(message)) return "This person isn't on your roster.";
  if (/team_member_inactive/i.test(message)) return "This person is archived. Restore them before inviting.";
  if (/department_not_found/i.test(message)) return "That department no longer exists.";
  if (/master_user_required|not_authorized|42501/i.test(message)) return "Only the studio owner can manage access.";
  if (/function .* does not exist|schema cache/i.test(message)) return "Run the latest database migration (frictionless team invites) first.";
  return message || "We couldn't complete that. Please try again.";
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function useTeamAccess({ activeOrganizationId = "", studioAccess = null } = {}) {
  const canManage = Boolean(
    studioAccess?.is_member === true &&
    studioAccess?.role === "master_user" &&
    studioAccess?.organization_id === activeOrganizationId
  );
  const [departments, setDepartments] = useState([]);
  const [overview, setOverview] = useState([]);
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [shownLink, setShownLink] = useState(null); // { memberId, url } when clipboard is unavailable

  const reload = useCallback(async () => {
    if (!canManage || !activeOrganizationId) { setDepartments([]); setOverview([]); return; }
    try {
      const [departmentRows, overviewRows] = await Promise.all([
        chatApi.departments(activeOrganizationId),
        chatApi.teamAccessOverview(activeOrganizationId),
      ]);
      setDepartments(departmentRows || []);
      setOverview(overviewRows || []);
    } catch (loadError) {
      setError(readableError(loadError));
    }
  }, [activeOrganizationId, canManage]);

  useEffect(() => { reload(); }, [reload]);

  const byMember = useMemo(() => new Map(overview.map((row) => [String(row.team_member_id), row])), [overview]);

  const run = useCallback(async (key, work, successNotice = "") => {
    setBusyKey(key); setError(""); setNotice("");
    try { await work(); if (successNotice) setNotice(successNotice); await reload(); return true; }
    catch (runError) { setError(readableError(runError)); return false; }
    finally { setBusyKey(""); }
  }, [reload]);

  const createLink = useCallback((member, departmentId) => run(`invite:${member.id}`, async () => {
    const token = createInviteToken();
    await chatApi.createTeamInvite({
      organizationId: activeOrganizationId, teamMemberId: member.id,
      departmentId: departmentId || null, role: inviteRoleFor(departmentId), token,
    });
    const url = buildInviteLink(token, window.location.origin);
    const copied = await copyText(url);
    setShownLink(copied ? null : { memberId: String(member.id), url });
    setNotice(copied
      ? `Invite link for ${member.name} copied. It works once and expires in 7 days.`
      : "Copy the invite link below. It works once and expires in 7 days.");
  }), [activeOrganizationId, run]);

  const revokeInvite = useCallback((row) => run(`revoke:${row.team_member_id}`, async () => {
    await chatApi.revokeTeamInvite(row.invite_id);
    setShownLink(null);
  }, "Invite revoked."), [run]);

  const moveMember = useCallback((member, departmentId) => run(`move:${member.id}`,
    () => chatApi.setMemberDepartment(activeOrganizationId, member.id, departmentId || null),
    "Access updated."), [activeOrganizationId, run]);

  const setActive = useCallback((member, active) => run(`active:${member.id}`,
    () => chatApi.setMemberAccess(activeOrganizationId, member.id, active),
    active ? "Access restored." : "Access paused."), [activeOrganizationId, run]);

  const createDepartment = useCallback((name) => run("department:new",
    () => chatApi.createDepartment(activeOrganizationId, name), `Department “${name}” created.`), [activeOrganizationId, run]);

  return {
    canManage, organizationId: activeOrganizationId, departments, byMember, busyKey, notice, error, shownLink,
    setNotice, setError, reload, createLink, revokeInvite, moveMember, setActive, createDepartment,
  };
}

// Compact per-person control rendered inside each Teams roster card.
export function MemberAccessRow({ member, access }) {
  const [departmentId, setDepartmentId] = useState("");
  if (!access?.canManage || member.status === "archived") return null;
  const row = access.byMember.get(String(member.id));
  const state = row?.state || "none";
  const busy = access.busyKey.endsWith(`:${member.id}`) || (row && access.busyKey === `revoke:${member.id}`);
  const stop = (event) => event.stopPropagation();
  const options = (
    <>
      <option value="">Freelancer portal</option>
      {access.departments.map((department) => <option key={department.department_id} value={department.department_id}>{department.name}</option>)}
    </>
  );
  const shown = access.shownLink?.memberId === String(member.id) ? access.shownLink.url : "";

  return (
    <div className="kf-access-row" onClick={stop} onKeyDown={stop} role="group" aria-label={`Access for ${member.name || "team member"}`}>
      {state === "none" && <>
        <select aria-label="Where this person works" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} disabled={busy}>{options}</select>
        <button type="button" className="kf-access-btn primary" disabled={busy} onClick={() => access.createLink(member, departmentId)}>{busy ? "Creating…" : "Copy invite link"}</button>
      </>}
      {state === "invited" && <>
        <span className="kf-access-chip pending">Invite pending · {describeAccess(row.role, row.department_name)}</span>
        <button type="button" className="kf-access-btn" disabled={busy} onClick={() => access.createLink(member, row.department_id || "")}>New link</button>
        <button type="button" className="kf-access-btn" disabled={busy} onClick={() => access.revokeInvite(row)}>Revoke</button>
      </>}
      {state === "active" && <>
        <span className="kf-access-chip active" title={row.login_email || ""}>Has login</span>
        <select aria-label="Change where this person works" value={row.department_id || ""} disabled={busy} onChange={(event) => access.moveMember(member, event.target.value)}>{options}</select>
        <button type="button" className="kf-access-btn" disabled={busy} onClick={() => access.setActive(member, false)}>Pause</button>
      </>}
      {state === "paused" && <>
        <span className="kf-access-chip paused">Access paused</span>
        <button type="button" className="kf-access-btn primary" disabled={busy} onClick={() => access.setActive(member, true)}>Restore</button>
      </>}
      {shown && <input className="kf-access-link" readOnly aria-label="Invite link" value={shown} onFocus={(event) => event.target.select()} />}
    </div>
  );
}

// Small banner under the Teams toolbar with the latest result; keeps feedback in one place.
export function AccessFeedback({ access }) {
  if (!access?.canManage || (!access.notice && !access.error)) return null;
  return <p className={`kf-access-feedback ${access.error ? "error" : "ok"}`} role={access.error ? "alert" : "status"}>{access.error || access.notice}</p>;
}

export function DepartmentsDrawer({ access, onClose }) {
  const [selectedId, setSelectedId] = useState("");
  const [rows, setRows] = useState([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    setSelectedId((current) => access.departments.some((d) => d.department_id === current) ? current : (access.departments[0]?.department_id || ""));
  }, [access.departments]);

  useEffect(() => {
    if (!selectedId) { setRows([]); return undefined; }
    let active = true;
    chatApi.departmentPermissions(access.organizationId, selectedId)
      .then((list) => { if (active) setRows(list || []); })
      .catch((err) => { if (active) setLocalError(readableError(err)); });
    return () => { active = false; };
  }, [access.organizationId, selectedId]);

  const setLevel = async (group, level) => {
    setBusy(true); setLocalError("");
    try {
      const wanted = new Set(keysForLevel(group, level));
      const have = new Set(rows.map((row) => row.permission_key));
      const all = [...group.view, ...group.edit];
      for (const key of all) {
        if (wanted.has(key) !== have.has(key)) {
          // eslint-disable-next-line no-await-in-loop
          await chatApi.setDepartmentPermission(access.organizationId, selectedId, key, wanted.has(key));
        }
      }
      setRows(await chatApi.departmentPermissions(access.organizationId, selectedId));
    } catch (err) { setLocalError(readableError(err)); }
    finally { setBusy(false); }
  };

  const addDepartment = async (event) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    const ok = await access.createDepartment(clean);
    if (ok) setName("");
    setBusy(false);
  };

  return (
    <div className="kf-dept-overlay" role="presentation" onClick={onClose}>
      <div className="kf-dept-drawer" role="dialog" aria-modal="true" aria-label="Departments" onClick={(event) => event.stopPropagation()}>
        <header><strong>Departments</strong><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
        <p className="kf-dept-hint">A department is a dedicated view. People in it see only what you switch on here, plus their own dashboard, settings and chat. People with no department use the freelancer portal.</p>
        {(localError || access.error) && <p className="kf-access-feedback error" role="alert">{localError || access.error}</p>}
        <div className="kf-dept-tabs" role="tablist">
          {access.departments.map((department) => (
            <button key={department.department_id} type="button" role="tab" aria-selected={department.department_id === selectedId}
              className={department.department_id === selectedId ? "on" : ""} onClick={() => setSelectedId(department.department_id)}>{department.name}</button>
          ))}
        </div>
        {selectedId && MODULE_ACCESS.map((group) => (
          <label key={group.id} className="kf-dept-module"><span>{group.label}</span>
            <select value={levelFor(rows, group)} disabled={busy} onChange={(event) => setLevel(group, event.target.value)}>
              <option value="none">No access</option><option value="view">View only</option><option value="edit">View &amp; edit</option>
            </select>
          </label>
        ))}
        <form className="kf-dept-new" onSubmit={addDepartment}>
          <input aria-label="New department name" value={name} onChange={(event) => setName(event.target.value)} placeholder="New department…" maxLength={80} />
          <button type="submit" disabled={busy || !name.trim()}>Add</button>
        </form>
      </div>
    </div>
  );
}
