import { createHash } from "node:crypto";

// Fake data for the mock field-service API. Each tenant gets its own ID range so a cross-tenant
// lookup is a clean "not found", and a canary string that must never show up in another
// tenant's tool output.

export interface Customer { id: number; name: string; phone: string; address: string; notes: string }
export interface Job {
  id: number;
  customerId: number;
  status: "Scheduled" | "InProgress" | "Completed" | "Canceled";
  type: string;
  summary: string;
  scheduledFor: string;
  technicianId: number;
}
export interface Estimate { id: number; customerId: number; jobId: number; status: "Open" | "Sold" | "Dismissed"; total: number; createdOn: string; summary: string }
export interface Invoice { id: number; customerId: number; jobId: number; total: number; balance: number; dueDate: string; memo: string }
export interface Technician { id: number; name: string }
export interface Appointment { id: number; technicianId: number; jobId: number; start: string; end: string }
export interface TenantData {
  customers: Customer[];
  jobs: Job[];
  estimates: Estimate[];
  invoices: Invoice[];
  technicians: Technician[];
  appointments: Appointment[];
}

export const SEED_TENANTS = [
  { tenant: "brand-north", stTenantId: 1001, base: 1000 },
  { tenant: "brand-central", stTenantId: 1002, base: 2000 },
  { tenant: "brand-coastal", stTenantId: 1003, base: 3000 },
];

export function canaryFor(tenant: string): string {
  return `CANARY-${tenant}-${createHash("sha256").update(tenant).digest("hex").slice(0, 8)}`;
}

export function isoDay(offsetDays: number, now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const NAMES = ["Avery Brooks", "Jordan Ellis", "Sam Patel", "Riley Chen", "Morgan Diaz", "Casey Nguyen", "Drew Walsh", "Jamie Ortiz"];
const STREETS = ["Maple Ave", "Harbor Rd", "Ridge St", "Elm Ct", "Lakeview Dr", "Mill Ln"];
const JOB_TYPES = [
  "AC tune-up", "Furnace repair", "Water heater install", "Drain cleaning",
  "Thermostat replacement", "Leak detection", "Heat pump service", "Sump pump repair",
];
const STATUSES: Job["status"][] = ["Scheduled", "InProgress", "Completed", "Completed", "Scheduled", "Canceled", "Completed", "Scheduled"];
const TECHS = ["Lee Harper", "Robin Shaw", "Alex Moreno", "Taylor Quinn", "Kim Foster", "Pat Lyons"];

export function seedTenant(tenant: string, base: number, now = new Date()): TenantData {
  const canary = canaryFor(tenant);
  const shift = Math.floor(base / 1000);

  const customers: Customer[] = Array.from({ length: 6 }, (_, i) => ({
    id: base + 1 + i,
    name: NAMES[(i + shift) % NAMES.length],
    phone: `555-01${shift}${i}`,
    address: `${100 + i * 12} ${STREETS[(i + shift) % STREETS.length]}`,
    notes: i === 0 ? `Gate code 4411. Prefers morning visits. ${canary}` : "No access notes.",
  }));

  const technicians: Technician[] = Array.from({ length: 3 }, (_, i) => ({
    id: base + 401 + i,
    name: TECHS[(i + shift) % TECHS.length],
  }));

  const jobs: Job[] = Array.from({ length: 8 }, (_, i) => ({
    id: base + 101 + i,
    customerId: customers[i % customers.length].id,
    status: STATUSES[i],
    type: JOB_TYPES[(i + shift) % JOB_TYPES.length],
    summary: i === 0 ? `Unit short-cycling, replaced capacitor. ${canary}` : `${JOB_TYPES[(i + shift) % JOB_TYPES.length]} per customer request.`,
    scheduledFor: isoDay(i - 3, now),
    technicianId: technicians[i % technicians.length].id,
  }));

  const estimates: Estimate[] = [
    { offset: -20, status: "Open", total: 6400 },
    { offset: -5, status: "Open", total: 1850 },
    { offset: -12, status: "Sold", total: 920 },
    { offset: -40, status: "Open", total: 11200 },
  ].map((e, i) => ({
    id: base + 201 + i,
    customerId: customers[i + 1].id,
    jobId: jobs[i + 1].id,
    status: e.status as Estimate["status"],
    total: e.total,
    createdOn: isoDay(e.offset, now),
    summary: i === 3 ? `System replacement option B. ${canary}` : `Repair estimate ${i + 1}`,
  }));

  const invoices: Invoice[] = [
    { due: -30, total: 420, balance: 420 },
    { due: -12, total: 610, balance: 0 },
    { due: 5, total: 980, balance: 980 },
    { due: -3, total: 150, balance: 150 },
    { due: -45, total: 1260, balance: 1260 },
  ].map((v, i) => ({
    id: base + 301 + i,
    customerId: customers[i].id,
    jobId: jobs[i].id,
    total: v.total,
    balance: v.balance,
    dueDate: isoDay(v.due, now),
    memo: i === 4 ? `Second notice pending. ${canary}` : "Net 30",
  }));

  const appointments: Appointment[] = jobs
    .filter((j) => j.status === "Scheduled" || j.status === "InProgress")
    .map((j, i) => ({
      id: base + 501 + i,
      technicianId: j.technicianId,
      jobId: j.id,
      start: `${j.scheduledFor}T${String(8 + (i % 4) * 2).padStart(2, "0")}:00:00Z`,
      end: `${j.scheduledFor}T${String(10 + (i % 4) * 2).padStart(2, "0")}:00:00Z`,
    }));

  return { customers, jobs, estimates, invoices, technicians, appointments };
}
