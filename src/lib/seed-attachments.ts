import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { recordActivity } from './events.js';

/** A demo image drawn from shapes only (no fonts: the docker image may have none). */
async function mockupPng(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <rect width="1200" height="800" fill="#f6f8f9"/>
    <rect width="1200" height="96" fill="#4186e0"/>
    <rect x="48" y="32" width="180" height="32" rx="6" fill="#ffffff" opacity="0.9"/>
    <rect x="96" y="176" width="560" height="56" rx="8" fill="#151b26"/>
    <rect x="96" y="256" width="460" height="24" rx="6" fill="#6d6e6f"/>
    <rect x="96" y="296" width="400" height="24" rx="6" fill="#6d6e6f"/>
    <rect x="96" y="360" width="200" height="56" rx="28" fill="#e8384f"/>
    <rect x="720" y="160" width="400" height="300" rx="16" fill="#aa62e3" opacity="0.85"/>
    <rect x="96" y="520" width="320" height="200" rx="12" fill="#ffffff" stroke="#e0e6e8" stroke-width="2"/>
    <rect x="440" y="520" width="320" height="200" rx="12" fill="#ffffff" stroke="#e0e6e8" stroke-width="2"/>
    <rect x="784" y="520" width="320" height="200" rx="12" fill="#ffffff" stroke="#e0e6e8" stroke-width="2"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A small, valid one-page PDF (Helvetica is built into every reader). */
export function briefPdf(lines: string[]): Buffer {
  const text = lines
    .map((line, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${720 - i * 28} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** POST /tasks/:id/attachments as a seed user, through the real upload path (multipart built by hand). */
async function upload(app: FastifyInstance, cookie: string, taskId: string, filename: string, data: Buffer, draft = false) {
  const boundary = '----mekari-seed';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/attachments${draft ? '?draft=true' : ''}`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`Seed upload ${filename} failed (${res.statusCode}): ${res.body}`);
  return res.json() as { id: string };
}

type Person = { id: string; cookie: string };

/**
 * SPEC §13 seed: a PNG, a PDF, a text file and a link (preset READY metadata: no network) on one task,
 * plus a comment with an image. Returns how many attachments it made.
 */
export async function seedAttachments(app: FastifyInstance, taskId: string, owner: Person, commenter: Person) {
  await upload(app, owner.cookie, taskId, 'Homepage mockup.png', await mockupPng());
  await upload(
    app,
    owner.cookie,
    taskId,
    'Project brief.pdf',
    briefPdf(['Project brief', 'Goals: faster pages, a CMS the team can use, one design system.', 'Launch: end of quarter.']),
  );
  await upload(
    app,
    owner.cookie,
    taskId,
    'release-notes.txt',
    Buffer.from('Release notes\n\n- New homepage hero\n- Faster image loading\n- Fixed the footer links on mobile\n'),
  );

  const task = await app.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { workspaceId: true } });
  await app.db.$transaction(async (tx) => {
    const link = await tx.attachment.create({
      data: {
        workspaceId: task.workspaceId,
        taskId,
        uploaderId: owner.id,
        kind: 'LINK',
        url: 'https://www.figma.com/file/mekari-demo/Homepage-mockups',
        title: 'Homepage mockups',
        description: 'Desktop and mobile layouts for the new homepage, with the component states.',
        siteName: 'Figma',
        provider: 'figma',
        previewStatus: 'READY',
      },
    });
    await recordActivity(tx, taskId, owner.id, 'ATTACHMENT_ADDED', { attachmentId: link.id, kind: 'LINK', name: link.title });
  });

  const shot = await upload(app, commenter.cookie, taskId, 'Screenshot.png', await mockupPng(), true);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/comments`,
    headers: { cookie: commenter.cookie },
    payload: { body: 'The hero looks great on mobile, see the screenshot.', attachmentIds: [shot.id] },
  });
  if (res.statusCode !== 201) throw new Error(`Seed comment with attachment failed (${res.statusCode}): ${res.body}`);
  return 5;
}
