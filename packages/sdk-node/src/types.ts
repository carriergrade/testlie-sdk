/** Shapes returned by the Testlie REST API. Dates are ISO 8601 strings, as sent over the wire. */

export type SmtpSettings = {
  host: string;
  ports: number[];
  username: string;
  password: string;
  auth: string[];
  tls: boolean;
};

export type Inbox = {
  id: string;
  name: string;
  projectId: string | null;
  emailAlias: string;
  /** `<alias>@<inbound domain>`, or null when the server has no inbound domain. */
  inboundAddress: string | null;
  maxMessages: number;
  /** Disposable inboxes are deleted with their messages at this time. */
  expiresAt: string | null;
  createdAt: string;
  messageCount?: number;
  unreadCount?: number;
  smtp: SmtpSettings;
};

export type Address = { address: string; name: string };

export type MessageSummary = {
  id: string;
  inboxId: string;
  subject: string;
  from: { address: string | null; name: string | null };
  to: Address[];
  cc: Address[];
  envelopeTo: string[];
  size: number;
  isRead: boolean;
  receivedAt: string;
};

export type Attachment = {
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
};

export type Message = Omit<MessageSummary, "envelopeTo"> & {
  messageId: string | null;
  bcc: string[];
  envelope: { from: string | null; to: string[] };
  html: string | null;
  text: string | null;
  headers: Record<string, unknown> | { key: string; value: string }[];
  attachments: Attachment[];
};

export type MessageList = { total: number; page: number; limit: number; messages: MessageSummary[] };

export type ExtractedLink = { url: string; text: string; originalUrl?: string };
export type ExtractedCode = { value: string; context: string; score: number };
export type ExtractedMagicLink = ExtractedLink & { reason: string; score: number };
export type Extraction = {
  messageId: string;
  subject: string;
  links: ExtractedLink[];
  /** Likely one-time codes, most likely first. */
  codes: ExtractedCode[];
  /** Verify, reset, sign-in, invite... links, most likely first. */
  magicLinks: ExtractedMagicLink[];
};

export type WebhookEvent = "message.received" | "sms.received" | "push.received" | (string & {});

export type Webhook = {
  id: string;
  inboxId: string | null;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
  /** Only returned to admins and API keys. */
  secret?: string;
};

export type Idp = {
  id: string;
  name: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  tokenTtl: number;
  autoLoginUserId: string | null;
  requireTeamSession: boolean;
  saml: { spEntityId: string | null; acsUrl: string | null; nameIdFormat: string };
  certificate: string;
  userCount?: number;
  urls: Record<string, string>;
  createdAt: string;
};

export type IdpUser = {
  id: string;
  subject: string;
  email: string;
  name: string;
  groups: string[];
  claims: Record<string, unknown>;
  createdAt: string;
};

export type PushService = "apns" | "fcm";

/** A notification captured by the push sandbox (APNs- or FCM-compatible endpoint). */
export type PushNotification = {
  id: string;
  pushInboxId: string;
  service: PushService;
  /** apns-id for APNs; the last segment of the FCM message name. */
  messageId: string;
  token: string | null;
  topic: string | null;
  condition: string | null;
  pushType: string | null;
  priority: string | null;
  expiration: string | null;
  collapseId: string | null;
  title: string;
  body: string;
  /** The APNs JSON payload, or the FCM message object. */
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  isRead: boolean;
  receivedAt: string;
  /** Likely one-time codes (best first) and links from the title, body and data values. */
  extracted?: { codes: string[]; links: string[] };
};

export type PushDevice = {
  id: string;
  platform: PushService;
  token: string;
  label: string;
  topic: string | null;
  outcome: "deliver" | "unregistered" | "bad_token" | "wrong_sender";
  createdAt: string;
};
