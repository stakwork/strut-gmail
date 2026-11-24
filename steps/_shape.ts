/** A message's shape, as every mail step hands it over (`Mail` in ./_gmail.ts). */
import { z } from "strut";

const address = z.object({ address: z.string(), name: z.string().optional() });

export const mail = z.object({
  id: z.string(),
  thread: z.string(),
  from: address.optional(),
  to: z.array(address),
  cc: z.array(address),
  replyTo: z.array(address).optional().describe("Where the sender asked replies to go, when it is not `from`"),
  subject: z.string(),
  date: z.string().describe("When the mailbox got it, or sent it (ISO 8601)"),
  text: z.string(),
  truncated: z.boolean().optional().describe("The text was cut at 20,000 characters"),
  attachments: z.array(z.string()).describe("The names of its attachments; never their contents"),
  mine: z.boolean().describe("This mailbox sent it"),
  machine: z.boolean().describe("A list or a machine sent it"),
});

/** What `draft` and `send` take. */
export const compose = {
  thread: z.string().optional().describe("Reply in this thread, to its latest message: to whoever sent it, or its Reply-To. Without it, a new message"),
  to: z.union([z.string(), z.array(z.string())]).optional().describe("Whom it goes to: an address, `Name <address>`, or a list. Needed for a new message; in a thread, in place of the reply's own"),
  subject: z.string().max(500).optional().describe("A new message's subject. A reply keeps its thread's"),
  text: z.string().min(1).max(100_000).describe("The message, plain text"),
};
