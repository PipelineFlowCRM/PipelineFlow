import { PrismaClient, Prisma } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

const STAGES = [
  { name: 'Lead', order: 1, color: '#94a3b8', isDefault: true, isWon: false, isLost: false },
  { name: 'Screening', order: 2, color: '#60a5fa', isDefault: true, isWon: false, isLost: false },
  { name: 'Meeting', order: 3, color: '#a78bfa', isDefault: true, isWon: false, isLost: false },
  { name: 'Proposal', order: 4, color: '#f59e0b', isDefault: true, isWon: false, isLost: false },
  { name: 'Customer', order: 5, color: '#10b981', isDefault: true, isWon: true, isLost: false },
  { name: 'Lost', order: 6, color: '#ef4444', isDefault: true, isWon: false, isLost: true },
];

const COMPANIES = [
  ['Acme Corp', 'Manufacturing', 'acme.com', '201-1000'],
  ['Globex', 'Software', 'globex.io', '51-200'],
  ['Initech', 'Consulting', 'initech.com', '11-50'],
  ['Umbrella Health', 'Healthcare', 'umbrella.health', '1000+'],
  ['Stark Industries', 'Aerospace', 'stark.com', '1000+'],
  ['Wayne Enterprises', 'Conglomerate', 'wayne.com', '1000+'],
  ['Hooli', 'Software', 'hooli.com', '201-1000'],
  ['Pied Piper', 'Software', 'piedpiper.com', '1-10'],
  ['Vandelay Industries', 'Imports', 'vandelay.com', '11-50'],
  ['Wonka Inc.', 'Food & Beverage', 'wonka.com', '201-1000'],
] as const;

const FIRST = ['Alex','Jordan','Taylor','Morgan','Casey','Riley','Sam','Avery','Quinn','Drew','Cameron','Reese','Skyler','Blake','Hayden','Rowan'];
const LAST = ['Chen','Patel','Garcia','Johnson','Singh','Rodriguez','Kim','Nguyen','Smith','Hassan','Brown','Lee','Davis','Cohen'];
const TITLES = ['VP Sales','CEO','CTO','Head of Ops','Director of Marketing','Procurement Manager','Founder','VP Engineering'];

const TAGS = [
  ['Hot', '#ef4444'],
  ['Enterprise', '#6366f1'],
  ['SMB', '#10b981'],
  ['Inbound', '#0ea5e9'],
  ['Outbound', '#f59e0b'],
  ['Renewal', '#a78bfa'],
] as const;

const DEAL_TITLES = [
  'Annual contract renewal','Q3 expansion deal','Pilot to enterprise upgrade',
  'Multi-year platform license','Procurement automation project','Onboarding services package',
  'Premium support tier','Data migration engagement','API integration buildout',
  'Self-serve to enterprise upgrade','Marketing automation rollout','Custom analytics dashboard',
  'Training and enablement','Security audit + remediation','Strategic partnership pilot',
  'Net-new logo — Series B startup','Replacement of legacy system','International expansion deal',
];

const NOTE_SAMPLES = [
  'Initial discovery call went well. They\'re evaluating us against two competitors.',
  'Champion confirmed budget. Targeting end-of-quarter close.',
  'Sent over the proposal — awaiting legal review on their side.',
  'Great demo today. CFO is the next stakeholder we need to convince.',
  'Pricing concerns surfaced. Putting together a custom package.',
  'Follow-up scheduled for next Tuesday.',
];

const TASK_SAMPLES: Array<[string, number]> = [
  ['Send recap email', 1],
  ['Prepare proposal v2', 4],
  ['Demo follow-up call', 2],
  ['Get legal sign-off', 7],
  ['Schedule technical deep dive', 5],
  ['Procurement intro call', 3],
  ['Draft contract', 6],
  ['Champion alignment meeting', 2],
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sample<T>(arr: readonly T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}
function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

async function main() {
  console.log('▶ Resetting demo data…');

  // Wipe in dependency order
  await prisma.activity.deleteMany();
  await prisma.note.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.company.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.pipelineStage.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();

  // Stages
  await prisma.pipelineStage.createMany({ data: STAGES });
  const stages = await prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } });

  // Demo user
  const passwordHash = await argon2.hash('demo1234', { type: argon2.argon2id });
  const demo = await prisma.user.create({
    data: {
      email: 'demo@pipelineflow.app',
      name: 'Demo User',
      passwordHash,
      avatarColor: '#6366f1',
    },
  });

  // Tags
  await prisma.tag.createMany({ data: TAGS.map(([name, color]) => ({ name, color })) });
  const tagRows = await prisma.tag.findMany();

  // Companies
  await prisma.company.createMany({
    data: COMPANIES.map(([name, industry, website, size]) => ({
      name, industry, website, size,
      city: pick(['Austin', 'Boston', 'New York', 'San Francisco', 'Chicago', 'Denver']),
      state: pick(['TX', 'MA', 'NY', 'CA', 'IL', 'CO']),
    })),
  });
  const companies = await prisma.company.findMany();

  // Contacts
  for (const company of companies) {
    const count = rand(1, 3);
    for (let i = 0; i < count; i++) {
      const fn = pick(FIRST);
      const ln = pick(LAST);
      await prisma.contact.create({
        data: {
          firstName: fn,
          lastName: ln,
          email: `${fn.toLowerCase()}.${ln.toLowerCase()}@${company.website ?? 'example.com'}`,
          phone: `+1-555-${rand(100, 999)}-${rand(1000, 9999)}`,
          title: pick(TITLES),
          companyId: company.id,
          linkedin: `https://linkedin.com/in/${fn.toLowerCase()}${ln.toLowerCase()}`,
        },
      });
    }
  }
  const contacts = await prisma.contact.findMany();

  // Deals
  const today = new Date();
  const stageProb: Record<string, number> = {
    Lead: 10, Screening: 25, Meeting: 45, Proposal: 70, Customer: 100, Lost: 0,
  };
  const stageWeights = [4, 3, 3, 2, 1, 1];

  for (const title of DEAL_TITLES) {
    const company = pick(companies);
    const companyContacts = contacts.filter((c) => c.companyId === company.id);
    const contact = companyContacts.length ? pick(companyContacts) : null;

    // Weighted stage pick
    const totalW = stageWeights.slice(0, stages.length).reduce((a, b) => a + b, 0);
    let r = Math.random() * totalW;
    let stage = stages[0]!;
    for (let i = 0; i < stages.length; i++) {
      r -= stageWeights[i] ?? 1;
      if (r <= 0) { stage = stages[i]!; break; }
    }

    const amount = pick([5_000, 12_500, 22_000, 38_000, 75_000, 120_000, 250_000]);
    const isClosed = stage.isWon || stage.isLost;

    const deal = await prisma.deal.create({
      data: {
        title,
        amount: new Prisma.Decimal(amount),
        currency: 'USD',
        probability: stageProb[stage.name] ?? 30,
        expectedCloseDate: addDays(today, rand(-10, 60)),
        stageId: stage.id,
        companyId: company.id,
        primaryContactId: contact?.id ?? null,
        ownerId: demo.id,
        stageChangedAt: new Date(),
        closedAt: isClosed ? new Date() : null,
        tags: {
          connect: sample(tagRows, rand(0, 2)).map((t) => ({ id: t.id })),
        },
      },
    });

    // Activities
    await prisma.activity.create({
      data: {
        dealId: deal.id, kind: 'created',
        summary: `Deal created in ${stage.name}`, actorId: demo.id,
      },
    });
    if (stage.name !== 'Lead') {
      await prisma.activity.create({
        data: {
          dealId: deal.id, kind: 'stage_changed',
          summary: `Moved to ${stage.name}`, actorId: demo.id,
        },
      });
    }

    // Notes
    for (let i = 0; i < rand(0, 3); i++) {
      await prisma.note.create({
        data: { dealId: deal.id, content: pick(NOTE_SAMPLES), createdBy: demo.id },
      });
    }

    // Tasks
    for (let i = 0; i < rand(0, 3); i++) {
      const [tt, days] = pick(TASK_SAMPLES);
      const completed = Math.random() < 0.3;
      await prisma.task.create({
        data: {
          dealId: deal.id,
          title: tt,
          dueDate: addDays(today, days + rand(-2, 5)),
          assignedTo: demo.id,
          status: completed ? 'completed' : 'pending',
          completedAt: completed ? new Date() : null,
        },
      });
    }
  }

  // Case-insensitive unique index on companies.name (Postgres functional index).
  // Idempotent — safe to re-run.
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "ix_companies_name_lower" ON "Company" (lower(name))`,
  );

  console.log('✓ Seed complete.');
  console.log('  Login: demo@pipelineflow.app / demo1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
