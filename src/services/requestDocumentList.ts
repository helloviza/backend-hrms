// apps/backend/src/services/requestDocumentList.ts
//
// The booking documents of an approval request as a list — pure, no imports
// from routes, so the customer sanitiser (approvals.security.ts) can attach
// `_documents` to every request it returns. Access and streaming live in
// services/bookingDocuments.ts.
import path from "path";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();

/** What a customer-side viewer learns about one document. */
export type RequestDocument = {
  id: string;
  name: string;
  type: "Ticket" | "Voucher" | "Document";
  size: number;
  mime: string;
  uploadedAt?: string;
};

export const CUSTOMER_DOC_TYPES = new Set(["ticket", "voucher"]);
const typeLabel = (t: any): RequestDocument["type"] =>
  str(t).toLowerCase() === "ticket" ? "Ticket" : str(t).toLowerCase() === "voucher" ? "Voucher" : "Document";

/** Local path of a queue-uploaded file (meta.attachments[].path = /uploads/approvals/<file>). */
const approvalsUploadRoot = () => path.join(process.cwd(), "uploads", "approvals");

/**
 * The booking documents of a request, newest last. Pure: reads the document
 * only. `_sourceKey` / `_localPath` are for the server's own use and are
 * removed before anything reaches a viewer (see publicDocuments).
 */
export function requestDocuments(doc: AnyObj): Array<RequestDocument & { _s3Key?: string; _localPath?: string }> {
  const out: Array<RequestDocument & { _s3Key?: string; _localPath?: string }> = [];
  for (const d of Array.isArray(doc?.meta?.bookingDocuments) ? doc.meta.bookingDocuments : []) {
    if (!CUSTOMER_DOC_TYPES.has(str(d?.type).toLowerCase()) || !str(d?.s3Key) || !str(d?.attachmentId)) continue;
    out.push({
      id: `mb-${str(d.attachmentId)}`,
      name: str(d.filename) || "document.pdf",
      type: typeLabel(d.type),
      size: Number(d.size) || 0,
      mime: str(d.mime) || "application/pdf",
      uploadedAt: d.uploadedAt ? new Date(d.uploadedAt).toISOString() : undefined,
      _s3Key: str(d.s3Key),
    });
  }
  for (const a of Array.isArray(doc?.meta?.attachments) ? doc.meta.attachments : []) {
    if (str(a?.kind) !== "admin_pdf") continue;
    const file = path.basename(str(a?.path));
    if (!file) continue;
    out.push({
      id: `ap-${file}`,
      name: str(a.filename) || file,
      type: "Document",
      size: Number(a.size) || 0,
      mime: str(a.mime) || "application/pdf",
      uploadedAt: a.uploadedAt ? new Date(a.uploadedAt).toISOString() : undefined,
      _localPath: path.join(approvalsUploadRoot(), file),
    });
  }
  return out;
}

/** The list as a viewer receives it: no keys, no paths, no URLs. */
export function publicDocuments(doc: AnyObj): RequestDocument[] {
  return requestDocuments(doc).map(({ _s3Key, _localPath, ...d }) => d);
}
