import { api } from './api';

interface PresignResponse {
  key: string;
  url: string;
  expiresIn: number;
}

export async function uploadToS3(
  file: File,
  scope: 'attachment' | 'avatar' | 'logo',
  link: { dealId?: number; taskId?: number; companyId?: number; userId?: number } = {},
): Promise<{ key: string }> {
  const presign = await api.post<PresignResponse>('/uploads/presign', {
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    scope,
    dealId: link.dealId ?? null,
    taskId: link.taskId ?? null,
    companyId: link.companyId ?? null,
  });

  const put = await fetch(presign.url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!put.ok) throw new Error(`S3 upload failed: ${put.status}`);

  // For attachments, persist the row server-side. Avatars/logos are just a
  // key the client passes back to /profile or /companies on save.
  if (scope === 'attachment') {
    await api.post('/uploads/attachments', {
      key: presign.key,
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      dealId: link.dealId ?? null,
      taskId: link.taskId ?? null,
    });
  }
  return { key: presign.key };
}
