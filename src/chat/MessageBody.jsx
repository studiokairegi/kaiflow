import React from "react";
import { parseMessageBody } from "./logic.js";

// Renders a stored plain-text message as React elements. No HTML is ever interpreted:
// markup in a message shows up literally, and only http(s) links become anchors.
function Inline({ tokens }) {
  return tokens.map((token, index) => {
    switch (token.t) {
      case "link": return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer nofollow">{token.v}</a>;
      case "bold": return <strong key={index}>{token.v}</strong>;
      case "em": return <em key={index}>{token.v}</em>;
      case "code": return <code key={index}>{token.v}</code>;
      default: return <React.Fragment key={index}>{token.v}</React.Fragment>;
    }
  });
}

export default function MessageBody({ body }) {
  const blocks = React.useMemo(() => parseMessageBody(body), [body]);
  if (!blocks.length) return null;
  return (
    <div className="chat-body-text">
      {blocks.map((block, index) => {
        if (block.type === "code") return <pre key={index}><code>{block.text}</code></pre>;
        if (block.type === "ul" || block.type === "ol") {
          const List = block.type;
          return <List key={index}>{block.items.map((tokens, i) => <li key={i}><Inline tokens={tokens} /></li>)}</List>;
        }
        return <p key={index}>{block.lines.map((tokens, i) => <React.Fragment key={i}>{i > 0 && <br />}<Inline tokens={tokens} /></React.Fragment>)}</p>;
      })}
    </div>
  );
}
