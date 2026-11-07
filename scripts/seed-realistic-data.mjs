import { randomUUID } from 'node:crypto';
import { mintToken } from './local-auth-server.mjs';

const API_BASE = 'http://localhost:3000/api/v1';
const token = mintToken('e68fcf27-7fe4-4944-bb42-0eac5da720a5', 'luis@presupuestos.app');

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    throw new Error(`API ${options.method || 'GET'} ${path} failed (${res.status}): ${text}`);
  }
  return json;
}

async function run() {
  console.log('--- Starting realistic data seeding via API ---');

  // 1. Me (initializes profile and system account)
  const me = await api('/me');
  console.log('Profile ensured:', me.id);

  // 2. Accounts
  console.log('Creating accounts...');
  const cashAccount = await api('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'Efectivo cartera', kind: 'cash', currency: 'MXN' }),
  });
  const bankAccount = await api('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'BBVA Débito', kind: 'cash', currency: 'MXN' }),
  });
  const creditAccount = await api('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'Tarjeta BBVA Oro', kind: 'credit', currency: 'MXN' }),
  });
  const receivableAccount = await api('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'Préstamo Carlos', kind: 'receivable', currency: 'MXN' }),
  });

  // 3. Opening balances
  console.log('Recording opening balances...');
  await api('/transactions/opening-balances', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-10-01',
      description: 'Saldos iniciales',
      balances: [
        { accountId: cashAccount.id, balanceCents: '350000' },     // $3,500.00
        { accountId: bankAccount.id, balanceCents: '2450000' },   // $24,500.00
        { accountId: creditAccount.id, balanceCents: '-420000' },  // -$4,200.00 deuda
        { accountId: receivableAccount.id, balanceCents: '85000' },// $850.00
      ],
    }),
  });

  // 4. Income source
  console.log('Creating income source...');
  const sueldoSource = await api('/income-sources', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sueldo Tech' }),
  });

  // 5. Categories (Sobres)
  console.log('Creating 7 envelopes...');
  const comida = await api('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Comida', rolloverType: 'reset' }),
  });
  const transporte = await api('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Transporte', rolloverType: 'reset' }),
  });
  const servicios = await api('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Servicios', rolloverType: 'accumulate' }),
  });
  const hogar = await api('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Hogar', rolloverType: 'reset' }),
  });
  const salud = await api('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Salud', rolloverType: 'accumulate' }),
  });
  const personal = await api('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Personal', rolloverType: 'reset' }),
  });
  const ahorro = await api('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ahorro', rolloverType: 'accumulate' }),
  });

  // 6. Period 1 (Previous closed period)
  console.log('Creating Period 1 (2026-10-16 - 2026-10-31)...');
  const period1 = await api('/periods', {
    method: 'POST',
    body: JSON.stringify({ startsOn: '2026-10-16', endsOn: '2026-10-31' }),
  });

  // Allocations on Period 1
  console.log('Allocating budget for Period 1...');
  await api(`/periods/${period1.id}/allocations/${comida.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '400000' }) });
  await api(`/periods/${period1.id}/allocations/${transporte.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '120000' }) });
  await api(`/periods/${period1.id}/allocations/${servicios.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '150000' }) });
  await api(`/periods/${period1.id}/allocations/${hogar.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '100000' }) });
  await api(`/periods/${period1.id}/allocations/${salud.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '80000' }) });
  await api(`/periods/${period1.id}/allocations/${personal.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '100000' }) });
  await api(`/periods/${period1.id}/allocations/${ahorro.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '250000' }) });

  // Expenses in Period 1
  console.log('Recording expenses in Period 1...');
  await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-10-18',
      description: 'Supermercado Chedraui',
      paidFromAccountId: bankAccount.id,
      totalCents: '125000',
      lines: [{ categoryId: comida.id, amountCents: '125000' }],
    }),
  });

  await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-10-22',
      description: 'Gasolina Shell',
      paidFromAccountId: creditAccount.id,
      totalCents: '45000',
      lines: [{ categoryId: transporte.id, amountCents: '45000' }],
    }),
  });

  await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-10-25',
      description: 'Recibo CFE',
      paidFromAccountId: bankAccount.id,
      totalCents: '72000',
      lines: [{ categoryId: servicios.id, amountCents: '72000' }],
    }),
  });

  // 7. Period 2 (Current open period) must exist before closing Period 1
  console.log('Creating Period 2 (2026-11-01 - 2026-11-15)...');
  const period2 = await api('/periods', {
    method: 'POST',
    body: JSON.stringify({ startsOn: '2026-11-01', endsOn: '2026-11-15' }),
  });

  // 8. Close Period 1
  console.log('Closing Period 1...');
  await api(`/periods/${period1.id}/close`, {
    method: 'POST',
  });

  // 9. Allocations in Period 2 (Current open period)
  console.log('Setting target allocations in Period 2...');
  await api(`/periods/${period2.id}/allocations/${comida.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '450000' }) });
  await api(`/periods/${period2.id}/allocations/${transporte.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '150000' }) });
  await api(`/periods/${period2.id}/allocations/${servicios.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '180000' }) });
  await api(`/periods/${period2.id}/allocations/${hogar.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '120000' }) });
  await api(`/periods/${period2.id}/allocations/${salud.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '60000' }) });
  await api(`/periods/${period2.id}/allocations/${personal.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '100000' }) });
  await api(`/periods/${period2.id}/allocations/${ahorro.id}`, { method: 'PUT', body: JSON.stringify({ targetAssignedCents: '300000' }) });

  // 9b. Income in Period 2: Nómina quincenal
  console.log('Recording salary income ($18,000.00 into BBVA Débito from Sueldo Tech)...');
  await api('/transactions/incomes', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-11-01',
      description: 'Nómina quincenal',
      toAccountId: bankAccount.id,
      sourceId: sueldoSource.id,
      amountCents: '1800000',
    }),
  });

  // 10. Expenses in Period 2 spread across categories
  console.log('Recording expenses in Period 2...');
  await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-11-01',
      description: 'Despensa semanal Walmart',
      paidFromAccountId: bankAccount.id,
      totalCents: '85050',
      lines: [{ categoryId: comida.id, amountCents: '85050' }],
    }),
  });

  await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-11-01',
      description: 'Carga TAG autopista',
      paidFromAccountId: creditAccount.id,
      totalCents: '25000',
      lines: [{ categoryId: transporte.id, amountCents: '25000' }],
    }),
  });

  await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-11-01',
      description: 'Cafetería y libro',
      paidFromAccountId: cashAccount.id,
      totalCents: '32000',
      lines: [{ categoryId: personal.id, amountCents: '32000' }],
    }),
  });

  // 11. Overspent envelope: Salud assigned $600 (or $600 + rollover), expense is $1,150.00
  console.log('Creating overspend on Salud ($1,150.00 against budget)...');
  await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-11-01',
      description: 'Consulta especialista y medicamentos',
      paidFromAccountId: bankAccount.id,
      totalCents: '115000',
      lines: [{ categoryId: salud.id, amountCents: '115000' }],
    }),
  });

  // 12. Late capture expense (bookedAt: 2026-10-28 in closed Period 1)
  console.log('Recording late-capture expense in closed Period 1...');
  const lateCapture = await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-10-28',
      description: 'Farmacia San Pablo (ticket atrasado)',
      paidFromAccountId: creditAccount.id,
      totalCents: '38000',
      lines: [{ categoryId: comida.id, amountCents: '38000' }],
    }),
  });
  console.log('Late capture impact status:', lateCapture.budgetImpact?.status);

  // 13. Corrected transaction and reversal
  console.log('Recording transaction and its reversal...');
  const txToReverse = await api('/transactions/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      bookedAt: '2026-11-01',
      description: 'Cargo duplicado restaurante',
      paidFromAccountId: cashAccount.id,
      totalCents: '42000',
      lines: [{ categoryId: comida.id, amountCents: '42000' }],
    }),
  });

  const txId = txToReverse.id || txToReverse.transaction?.id;
  await api(`/transactions/${txId}/reversal`, {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      description: 'Cobro duplicado por error en caja',
    }),
  });

  // 14. Recurring templates (Recordatorios)
  console.log('Creating recurring templates...');
  await api('/recurring-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Internet Totalplay Fibra',
      categoryId: servicios.id,
      accountId: bankAccount.id,
      amountCents: '70000',
      dayOfMonth: 5,
    }),
  });

  await api('/recurring-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Gimnasio Smart Fit',
      categoryId: personal.id,
      accountId: creditAccount.id,
      amountCents: '59900',
      dayOfMonth: 1,
    }),
  });

  await api('/recurring-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Seguro Auto HDI Mensual',
      categoryId: transporte.id,
      accountId: bankAccount.id,
      amountCents: '145000',
      dayOfMonth: 15,
    }),
  });

  console.log('--- Realistic scenario seeded successfully! ---');
}

run().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
