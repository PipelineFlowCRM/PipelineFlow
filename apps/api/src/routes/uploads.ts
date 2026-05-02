import { Router } from 'express';
import { attachmentCreateSchema, presignUploadSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import {
  buildKey,
  deleteObject,
  presignGet,
  presignInlineGet,
  presignPut,
  s3Configured,
} from '../lib/s3.js';
import { attachmentDto } from '../lib/serialize.js';
import { consumeIssuedKey, rememberIssuedKey } from '../lib/issuedKeys.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

uploadsRouter.post(
  '/presign',
  asyncHandler(async (req, res) => {
    if (!s3Configured()) throw new HttpError(503, 'S3 is not configured');
    const input = presignUploadSchema.parse(req.body);
    const key = buildKey(input.scope, input.filename);
    const url = await presignPut(key, input.contentType, input.sizeBytes);
    rememberIssuedKey(key);
    res.json({ key, url, expiresIn: 300 });
  }),
);

uploadsRouter.post(
  '/attachments',
  asyncHandler(async (req, res) => {
    const input = attachmentCreateSchema.parse(req.body);
    // Reject keys we didn't just hand out via /presign — without this an
    // authenticated client can register an attachment row pointing at any
    // existing object in the bucket (e.g. another user's avatar).
    if (!consumeIssuedKey(input.key)) {
      throw new HttpError(400, 'Unknown or expired upload key');
    }
    if (input.dealId != null) {
      const exists = await prisma.deal.findUnique({ where: { id: input.dealId } });
      if (!exists) throw new HttpError(404, 'Deal not found');
    }
    if (input.taskId != null) {
      const exists = await prisma.task.findUnique({ where: { id: input.taskId } });
      if (!exists) throw new HttpError(404, 'Task not found');
    }

    const a = await prisma.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({
        data: {
          storedKey: input.key,
          filename: input.filename,
          contentType: input.contentType ?? null,
          sizeBytes: input.sizeBytes ?? null,
          dealId: input.dealId ?? null,
          taskId: input.taskId ?? null,
          uploadedBy: req.user!.id,
        },
        include: { uploader: true },
      });
      if (attachment.dealId) {
        await tx.activity.create({
          data: {
            dealId: attachment.dealId,
            kind: 'file_added',
            summary: `Uploaded "${attachment.filename}"`,
            actorId: req.user!.id,
          },
        });
      }
      return attachment;
    });
    res.status(201).json({ attachment: attachmentDto(a) });
  }),
);

uploadsRouter.get(
  '/attachments/:id/url',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const a = await prisma.attachment.findUnique({ where: { id } });
    if (!a) throw new HttpError(404, 'Attachment not found');
    // `?inline=1` is used by image previews in the UI: it omits the
    // `Content-Disposition: attachment` header so the browser renders
    // the image instead of forcing a download. The default behaviour
    // (no flag) keeps the download semantics for non-image files and
    // for explicit "Download" actions.
    //
    // We refuse to honour `inline` for non-image content types — a user
    // could upload an HTML payload with a fake `Content-Type: image/png`
    // (the schema trusts client input here) and get the browser to render
    // it inline at the bucket origin. Different origin from the app, so
    // session cookies don't leak, but the bucket origin is still
    // reachable and there's no legitimate reason to inline a non-image.
    const requestedInline =
      req.query.inline === '1' || req.query.inline === 'true';
    const inline = requestedInline && !!a.contentType?.startsWith('image/');
    const url = inline
      ? await presignInlineGet(a.storedKey)
      : await presignGet(a.storedKey, a.filename);
    res.json({ url });
  }),
);

uploadsRouter.delete(
  '/attachments/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const a = await prisma.attachment.findUnique({ where: { id } });
    if (!a) throw new HttpError(404, 'Attachment not found');
    await deleteObject(a.storedKey).catch(() => undefined);
    await prisma.attachment.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
