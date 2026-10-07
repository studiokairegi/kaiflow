import React from "react";
import { S, T, Btn, Modal } from "./ui.jsx";

// Small chooser used when "New invoice" is started from Finance (invoices belong to a project).
export function ProjectPicker({ projects, onPick, onClose }) {
  const active = projects.filter((p) => !p.archived);
  return (
    <Modal title="Which project is this invoice for?" onClose={onClose} width={440}>
      {active.length === 0 && <p style={S.sub}>Create a project first. Invoices belong to a project.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
        {active.map((p) => (
          <Btn key={p.id} onClick={() => onPick(p)} style={{ textAlign: "left" }}>
            {p.name}{p.client ? <span style={{ color: T.muted }}> {"\u00b7"} {p.client}</span> : null}
          </Btn>
        ))}
      </div>
    </Modal>
  );
}
