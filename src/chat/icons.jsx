import React from "react";

// One coherent 24px stroke icon set for chat (rounded caps, 1.75 stroke, currentColor). Decorative:
// every control that uses an icon carries its own aria-label.
const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" };

const make = (children, extra = {}) => function Icon({ size = 20, className = "", filled = false, ...rest }) {
  return (
    <svg {...base} {...extra} width={size} height={size} className={`chat-icon ${className}`.trim()} fill={filled ? "currentColor" : "none"} {...rest}>
      {children}
    </svg>
  );
};

// New chat: a speech bubble holding a plus.
export const IconNewChat = make(<><path d="M20.5 11.6c0 3.7-3.7 6.6-8.2 6.6-1 0-2-.1-2.9-.4L5 19.9l1.2-3.6C4.8 15.2 3.9 13.5 3.9 11.6c0-3.7 3.7-6.6 8.2-6.6s8.4 2.9 8.4 6.6Z" /><path d="M12.2 8.6v6M9.2 11.6h6" /></>);

// Pin: a push-pin seen at an angle. `filled` is used for pinned messages.
export const IconPin = make(<><path d="M14.6 3.6c.3-.3.8-.3 1.1 0l4.7 4.7c.3.3.3.8 0 1.1l-1.2 1.2-2.6.6-2.9 2.9.2 3.2-1.2 1.2-3.2-3.2-5 5" /><path d="m5.4 9.9 1.2-1.2 3.2.2 2.9-2.9.6-2.6" /><path d="m9.4 14.6-3.6-3.6" /></>);

export const IconClose = make(<path d="M6 6l12 12M18 6 6 18" />);
export const IconBack = make(<path d="m14.5 5.5-6.5 6.5 6.5 6.5" />);
export const IconSend = make(<><path d="M20.8 3.2 10.4 13.6" /><path d="M20.8 3.2 14 20.8l-3.6-7.2L3.2 10 20.8 3.2Z" /></>);
export const IconPaperclip = make(<path d="m20 11.4-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.8 1.8 0 0 1-2.5-2.5l7.9-7.9" />);
export const IconSearch = make(<><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.2 4.2" /></>);
export const IconMembers = make(<><circle cx="9" cy="8.5" r="3.2" /><path d="M3.2 19.2c.5-3.2 2.9-5 5.8-5s5.3 1.8 5.8 5" /><circle cx="17" cy="9.5" r="2.4" /><path d="M16.8 14.4c2.3.1 3.7 1.5 4.1 3.8" /></>);
export const IconReply = make(<><path d="m9 14-5-5 5-5" /><path d="M4 9h9a7 7 0 0 1 7 7v2" /></>);
export const IconEdit = make(<><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>);
export const IconTrash = make(<><path d="M4.5 7h15M9.5 7V4.8h5V7" /><path d="m6.5 7 .8 12.2h9.4L17.5 7M10 11v5M14 11v5" /></>);
export const IconHistory = make(<><path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5" /><path d="M4 4v4.5h4.5M12 8v4.4l3 1.8" /></>);
export const IconSmile = make(<><circle cx="12" cy="12" r="8.5" /><path d="M8.6 14c.8 1.3 2 2 3.4 2s2.6-.7 3.4-2M9.2 9.6h.01M14.8 9.6h.01" /></>);
export const IconDown = make(<path d="M12 5v14M6 13l6 6 6-6" />);
export const IconRetry = make(<><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v5h-5" /></>);
export const IconFile = make(<><path d="M6 3.5h8l4.5 4.5v12a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" /><path d="M14 3.5V8h4.5M8.5 13h7M8.5 16.5h5" /></>);
export const IconImage = make(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 4 3.5 3-2.5 4.5 3.5" /></>);
export const IconGroup = make(<><circle cx="12" cy="8" r="3" /><circle cx="5.6" cy="10" r="2.2" /><circle cx="18.4" cy="10" r="2.2" /><path d="M6.6 19c.4-3 2.4-4.6 5.4-4.6s5 1.6 5.4 4.6M2.5 17.2c.2-2 1.3-3.1 3.1-3.3M21.5 17.2c-.2-2-1.3-3.1-3.1-3.3" /></>);
export const IconFolder = make(<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.5Z" />);
export const IconInbox = make(<><path d="M3.5 13.5 6.2 5.8a1 1 0 0 1 1-.8h9.6a1 1 0 0 1 1 .8l2.7 7.7v4.7a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-4.7Z" /><path d="M3.5 13.5h5l1.2 2.2h4.6l1.2-2.2h5" /></>);
export const IconLock = make(<><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>);
export const IconLink = make(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>);
export const IconCheck = make(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconUserPlus = make(<><circle cx="9.5" cy="8.5" r="3.4" /><path d="M3.5 19.2c.5-3.4 3-5.2 6-5.2s5.5 1.8 6 5.2M18 8v6M15 11h6" /></>);
export const IconDirect = make(<><path d="M4 5.5h16v10H12.5L8 19.5v-4H4v-10Z" /></>);

export const IconBell = make(<><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15L6 16.5Z" /><path d="M10 21a2.2 2.2 0 0 0 4 0" /></>);
export const IconBellOff = make(<><path d="M6 16.5V11c0-1 .2-1.900.6-2.700M9 5.600A6 6 0 0 1 18 11v5.500l1.500 2h-11" /><path d="M10 21a2.200 2.200 0 0 0 4 0M4 4l16 16" /></>);
