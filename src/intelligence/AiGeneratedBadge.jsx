// Marks a lead that KairFlow Intelligence created. The source of truth is leads.source_kind
// (set only by the database function that creates AI leads and immutable afterwards), so this badge
// survives edits and reassignment and can never appear on a manually created lead.
import { AI_SOURCE_KIND, isAiGeneratedLead } from "./logic.js";
export { AI_SOURCE_KIND, isAiGeneratedLead };

export default function AiGeneratedBadge({ style }) {
  return (
    <span
      title="Created by Emma · KairFlow Intelligence"
      style={{
        display: "inline-block", marginLeft: 8, padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 600,
        letterSpacing: 0.3, verticalAlign: "middle", border: "1px solid currentColor", opacity: 0.85, whiteSpace: "nowrap", ...style,
      }}
    >
      Emma
    </span>
  );
}
