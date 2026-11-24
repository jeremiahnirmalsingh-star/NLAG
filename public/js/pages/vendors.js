import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, reloadPage, withQuery } from '../router.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, emptyState, toast, field, modal,
  confirmDialog, fileSize, readFileAsBase64, ALLOWED_UPLOAD_EXT, MAX_UPLOAD_BYTES,
} from '../ui.js';

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query;
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.status) params.set('status', q.status);

  ctx.view.innerHTML = `<div class="empty">Loading vendors\u2026</div>`;
  const res = await api.get(`/api/vendors?${params.toString()}`);

  const counts = {
    active: res.vendors.filter((v) => v.status === 'Active').length,
    inactive: res.vendors.filter((v) => v.status === 'Inactive').length,
    blacklisted: res.vendors.filter((v) => v.status === 'Blacklisted').length,
    advance: res.vendors.reduce((s, v) => s + (v.outstandingAdvance || 0), 0),
  };

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Vendors</h1><div class="sub">Vendor master, statutory details and advance position</div></div>
      <div class="page-actions">
        ${can('vendor.create') ? `<a class="btn btn-primary" href="#/vendors/new">${icon('plus')} New Vendor</a>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('briefcase')}</div><div><div class="label">Total vendors</div><div class="value">${num(res.vendors.length)}</div><div class="meta">${num(counts.active)} active</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip gray">${icon('users')}</div><div><div class="label">Inactive</div><div class="value">${num(counts.inactive)}</div><div class="meta">Not available for new bills</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip red">${icon('xCircle')}</div><div><div class="label">Blacklisted</div><div class="value">${num(counts.blacklisted)}</div><div class="meta">Bills blocked</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('wallet')}</div><div><div class="label">Outstanding advances</div><div class="value small-value">${money(counts.advance, { decimals: 0 })}</div><div class="meta">Across all vendors</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="vendor-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Vendor name, code, GST, contact..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${['Active', 'Inactive', 'Blacklisted'].map((s) => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${res.vendors.length
          ? `<table class="tbl">
              <thead><tr><th>Vendor</th><th>Category</th><th>Contact</th><th>GST / PAN</th><th class="num">Bills</th><th class="num">Advance Balance</th><th>Status</th><th></th></tr></thead>
              <tbody>${res.vendors
                .map(
                  (v) => `<tr>
                    <td><a class="strong" href="#/vendors/${v.id}">${esc(v.name)}</a><div class="small muted mono">${esc(v.code)}</div></td>
                    <td>${esc(v.category || '\u2014')}</td>
                    <td>${esc(v.contactPerson || '\u2014')}<div class="small muted">${esc(v.mobile || '')}</div></td>
                    <td class="mono small">${esc(v.gstNumber || '\u2014')}<div class="muted">${esc(v.panNumber || '')}</div></td>
                    <td class="num">${num(v.billCount)}</td>
                    <td class="num ${v.outstandingAdvance ? 'text-amber fw-700' : ''}">${v.outstandingAdvance ? money(v.outstandingAdvance) : '\u2014'}</td>
                    <td>${statusBadge(v.status)}</td>
                    <td class="actions"><a class="btn btn-sm btn-ghost" href="#/vendors/${v.id}">${icon('eye')}</a></td>
                  </tr>`
                )
                .join('')}</tbody></table>`
          : emptyState('No vendors found', 'Add your first vendor to begin registering bills.', can('vendor.create') ? '<a class="btn btn-sm btn-primary" href="#/vendors/new">New Vendor</a>' : '', 'briefcase')}
      </div>
    </div>`;

  const form = document.getElementById('vendor-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/vendors', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/vendors'));
}

/* ================================================================== */
/* FORM                                                                */
/* ================================================================== */
export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  let vendor = {};
  let existingDocs = [];
  if (id) {
    const res = await api.get(`/api/vendors/${id}`);
    vendor = res.vendor;
    existingDocs = res.documents;
  }
  const pendingFiles = [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${id ? 'Edit Vendor' : 'New Vendor'}</h1>
        <div class="sub">${id ? esc(vendor.name) + ' \u00b7 ' + esc(vendor.code) : 'Register a vendor with statutory and bank details'}</div></div>
      <div class="page-actions">
        <a class="btn" href="${id ? `#/vendors/${id}` : '#/vendors'}">${icon('arrowLeft')} Cancel</a>
        <button class="btn btn-primary" data-save>${icon('check')} ${id ? 'Save changes' : 'Create vendor'}</button>
      </div>
    </div>
    <div id="vendor-alert" class="alert alert-danger hidden"></div>

    <form id="vendor-form">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Basic Information</h3><div class="sub">Identity and point of contact</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Vendor Name', name: 'name', value: vendor.name || '', required: true, span: true })}
                ${field({ label: 'Vendor Category', name: 'category', value: vendor.category || '', options: [
                  { value: '', label: '\u2014 Select category \u2014' },
                  ...['Office Supplies', 'Electrical', 'Plumbing', 'Furniture', 'Equipment', 'Travel', 'Events', 'Printing', 'Professional Services', 'Utilities', 'Maintenance', 'IT', 'Miscellaneous'].map((c) => ({ value: c, label: c })),
                ], type: 'select' })}
                ${field({ label: 'Status', name: 'status', type: 'select', value: vendor.status || 'Active', options: [
                  { value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }, { value: 'Blacklisted', label: 'Blacklisted' },
                ] })}
                ${field({ label: 'Contact Person', name: 'contactPerson', value: vendor.contactPerson || '' })}
                ${field({ label: 'Designation', name: 'designation', value: vendor.designation || '' })}
                ${field({ label: 'Mobile Number', name: 'mobile', value: vendor.mobile || '' })}
                ${field({ label: 'Email Address', name: 'email', type: 'email', value: vendor.email || '' })}
                <div class="field span-2"><label>Vendor Code</label>
                  <div class="input" style="background:#f6f8fb;display:flex;align-items:center">${esc(vendor.code || 'Auto-generated on save')}</div></div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Address</h3><div class="sub">Registered / billing address</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Address Line 1', name: 'addressLine1', value: vendor.addressLine1 || '', span: true })}
                ${field({ label: 'Address Line 2', name: 'addressLine2', value: vendor.addressLine2 || '', span: true })}
                ${field({ label: 'City', name: 'city', value: vendor.city || '' })}
                ${field({ label: 'State', name: 'state', value: vendor.state || '' })}
                ${field({ label: 'Pincode', name: 'pincode', value: vendor.pincode || '' })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Vendor Documents</h3><div class="sub">PAN, GST, bank proof, agreement, KYC</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Document Type', name: 'docType', type: 'select', value: 'PAN Copy', options: ['PAN Copy', 'GST Certificate', 'Bank Proof', 'Vendor Agreement', 'KYC Document', 'Other'].map((d) => ({ value: d, label: d })), span: true })}
              </div>
              <div class="dropzone" data-dropzone tabindex="0">${icon('upload')}
                <div><b>Click to upload</b> or drag documents here</div>
                <div class="small">PDF, JPG, PNG, DOCX, XLSX \u00b7 max 5 MB each</div>
              </div>
              <input type="file" id="vendor-files" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx" />
              <div class="file-list mt-12" data-docs>
                ${existingDocs
                  .map(
                    (d) => `<div class="file-item">
                      <div class="ficon">${icon('file')}</div>
                      <div style="min-width:0"><div class="fname">${esc(d.fileName)}</div><div class="fmeta">${esc(d.docType)} \u00b7 ${fileSize(d.size)}</div></div>
                      <div class="factions"><a class="btn btn-sm btn-ghost" href="${d.url}" target="_blank" rel="noopener">${icon('eye')}</a>
                      <button type="button" class="btn btn-sm btn-ghost" data-del-doc="${d.id}">${icon('trash')}</button></div>
                    </div>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Statutory Information</h3><div class="sub">Tax registration details</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'GST Number', name: 'gstNumber', value: vendor.gstNumber || '', placeholder: 'e.g. 32AABCA1234B1Z5' })}
                ${field({ label: 'PAN Number', name: 'panNumber', value: vendor.panNumber || '', placeholder: 'e.g. AABCA1234B' })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Bank Information</h3><div class="sub">For Accounts reference only \u2014 no payments are processed</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Bank Name', name: 'bankName', value: vendor.bankName || '' })}
                ${field({ label: 'Account Holder Name', name: 'accountHolder', value: vendor.accountHolder || '' })}
                ${field({ label: 'Account Number', name: 'accountNumber', value: vendor.accountNumber || '' })}
                ${field({ label: 'IFSC Code', name: 'ifscCode', value: vendor.ifscCode || '' })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Record</h3></div></div>
            <div class="card-body">
              <dl class="dl compact">
                <dt>Created</dt><dd>${vendor.createdAt ? fmtDate(vendor.createdAt, true) : 'On save'}</dd>
                <dt>Last updated</dt><dd>${vendor.updatedAt ? fmtDate(vendor.updatedAt, true) : '\u2014'}</dd>
                <dt>Bills raised</dt><dd>${num(vendor.billCount || 0)}</dd>
                <dt>Advance balance</dt><dd>${money(vendor.outstandingAdvance || 0)}</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('vendor-form');
  const alertBox = document.getElementById('vendor-alert');
  const docsBox = form.querySelector('[data-docs]');
  const fileInput = document.getElementById('vendor-files');
  const dropzone = form.querySelector('[data-dropzone]');

  const renderPending = () => {
    let box = form.querySelector('[data-pending-docs]');
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-pending-docs', '');
      docsBox.appendChild(box);
    }
    box.innerHTML = pendingFiles
      .map(
        (f, i) => `<div class="upload-item">${icon('file')}<span class="grow">${esc(f.name)}</span>
          <span class="small muted">${esc(f.docType)} \u00b7 ${fileSize(f.size)}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-remove-pending="${i}">${icon('x')}</button></div>`
      )
      .join('');
    box.querySelectorAll('[data-remove-pending]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingFiles.splice(Number(btn.dataset.removePending), 1);
        renderPending();
      });
    });
  };

  const addFiles = async (files) => {
    const docType = form.docType.value;
    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!ALLOWED_UPLOAD_EXT.includes(ext)) { toast(`${file.name}: file type not allowed.`, 'error'); continue; }
      if (file.size > MAX_UPLOAD_BYTES) { toast(`${file.name}: exceeds 5 MB.`, 'error'); continue; }
      const data = await readFileAsBase64(file);
      data.docType = docType;
      pendingFiles.push(data);
      renderPending();
    }
  };
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter') fileInput.click(); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('drag'); addFiles(Array.from(e.dataTransfer.files)); });
  fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });

  form.querySelectorAll('[data-del-doc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Remove document', message: 'Remove this document from the vendor record?', confirmText: 'Remove', danger: true });
      if (!ok) return;
      try {
        await api.del(`/api/vendors/${id}/documents/${btn.dataset.delDoc}`);
        btn.closest('.file-item').remove();
        toast('Document removed.');
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    const data = {
      name: form.name.value.trim(),
      category: form.category.value,
      contactPerson: form.contactPerson.value.trim(),
      designation: form.designation.value.trim(),
      mobile: form.mobile.value.trim(),
      email: form.email.value.trim(),
      gstNumber: form.gstNumber.value.trim(),
      panNumber: form.panNumber.value.trim(),
      addressLine1: form.addressLine1.value.trim(),
      addressLine2: form.addressLine2.value.trim(),
      city: form.city.value.trim(),
      state: form.state.value.trim(),
      pincode: form.pincode.value.trim(),
      bankName: form.bankName.value.trim(),
      accountNumber: form.accountNumber.value.trim(),
      ifscCode: form.ifscCode.value.trim(),
      accountHolder: form.accountHolder.value.trim(),
      status: form.status.value,
      documents: pendingFiles,
    };
    if (!data.name) {
      alertBox.innerHTML = `${icon('alert')} Vendor name is required.`;
      alertBox.classList.remove('hidden');
      return;
    }
    try {
      if (id) {
        await api.put(`/api/vendors/${id}`, data);
        toast('Vendor updated.');
        navigate(`/vendors/${id}`);
      } else {
        const res = await api.post('/api/vendors', data);
        toast(`Vendor created (${res.code}).`);
        navigate(`/vendors/${res.id}`);
      }
    } catch (e) {
      alertBox.innerHTML = `${icon('alert')}<div><b>${esc(e.message)}</b></div>`;
      alertBox.classList.remove('hidden');
    }
  });

  form.addEventListener('submit', (e) => e.preventDefault());
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, { id }) {
  ctx.view.innerHTML = `<div class="empty">Loading vendor\u2026</div>`;
  const data = await api.get(`/api/vendors/${id}`);
  const v = data.vendor;

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="small muted" style="margin-bottom:4px"><a href="#/vendors">Vendors</a> / ${esc(v.code)}</div>
        <h1 style="display:flex;align-items:center;gap:10px">${esc(v.name)} ${statusBadge(v.status)}</h1>
        <div class="sub">${esc(v.category || 'Uncategorised')} \u00b7 ${esc(v.contactPerson || 'No contact person')}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/vendors">${icon('arrowLeft')} Back</a>
        ${can('advance.create') ? `<a class="btn" href="#/advances?new=1&vendorId=${v.id}">${icon('wallet')} Record Advance</a>` : ''}
        ${can('bill.create') && v.status === 'Active' ? `<a class="btn btn-primary" href="#/bills/new?vendorId=${v.id}">${icon('plus')} New Bill</a>` : ''}
        ${can('vendor.edit') ? `<a class="btn" href="#/vendors/${v.id}/edit">${icon('edit')} Edit</a>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('file')}</div><div><div class="label">Bills raised</div><div class="value">${num(data.bills.length)}</div><div class="meta">Total history</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('wallet')}</div><div><div class="label">Outstanding advance</div><div class="value small-value">${money(v.outstandingAdvance || 0)}</div><div class="meta">${data.advances.filter((a) => a.balance > 0 && a.status !== 'Closed').length} open advance(s)</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('briefcase')}</div><div><div class="label">GST Number</div><div class="value small-value" style="font-size:15px">${esc(v.gstNumber || '\u2014')}</div><div class="meta">PAN ${esc(v.panNumber || '\u2014')}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('calendar')}</div><div><div class="label">Vendor since</div><div class="value small-value" style="font-size:17px">${fmtDate(v.createdAt)}</div><div class="meta mono">${esc(v.code)}</div></div></div></div>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Vendor Information</h3></div></div>
          <div class="card-body">
            <div class="grid grid-2">
              <dl class="dl compact">
                <dt>Vendor Code</dt><dd class="mono">${esc(v.code)}</dd>
                <dt>Category</dt><dd>${esc(v.category || '\u2014')}</dd>
                <dt>Contact Person</dt><dd>${esc(v.contactPerson || '\u2014')}${v.designation ? ` (${esc(v.designation)})` : ''}</dd>
                <dt>Mobile</dt><dd>${esc(v.mobile || '\u2014')}</dd>
                <dt>Email</dt><dd>${esc(v.email || '\u2014')}</dd>
                <dt>GST Number</dt><dd class="mono">${esc(v.gstNumber || '\u2014')}</dd>
                <dt>PAN Number</dt><dd class="mono">${esc(v.panNumber || '\u2014')}</dd>
              </dl>
              <dl class="dl compact">
                <dt>Address</dt><dd>${[v.addressLine1, v.addressLine2, v.city, v.state, v.pincode].filter(Boolean).map(esc).join(', ') || '\u2014'}</dd>
                <dt>Bank</dt><dd>${esc(v.bankName || '\u2014')}</dd>
                <dt>Account Number</dt><dd class="mono">${esc(v.accountNumber || '\u2014')}</dd>
                <dt>IFSC</dt><dd class="mono">${esc(v.ifscCode || '\u2014')}</dd>
                <dt>Account Holder</dt><dd>${esc(v.accountHolder || '\u2014')}</dd>
                <dt>Last Updated</dt><dd>${fmtDate(v.updatedAt, true)}</dd>
              </dl>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Recent Bills</h3><div class="sub">Latest bills raised against this vendor</div></div>
            <div class="actions"><a class="btn btn-sm" href="#${withQuery('/bills', { vendorId: v.id })}">View in Bills</a></div>
          </div>
          <div class="table-wrap">
            ${data.bills.length
              ? `<table class="tbl"><thead><tr><th>Bill No</th><th>Invoice</th><th>Date</th><th class="num">Net Amount</th><th>Status</th></tr></thead>
                  <tbody>${data.bills
                    .map(
                      (b) => `<tr><td><a class="strong" href="#/bills/${b.id}">${esc(b.bill_no)}</a></td>
                        <td class="mono small">${esc(b.invoice_number)}</td><td>${fmtDate(b.invoice_date)}</td>
                        <td class="num">${money(b.net_amount)}</td><td>${statusBadge(b.status)}</td></tr>`
                    )
                    .join('')}</tbody></table>`
              : '<div class="empty small">No bills raised yet.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Advance History</h3><div class="sub">Advances recorded for this vendor</div></div></div>
          <div class="table-wrap">
            ${data.advances.length
              ? `<table class="tbl"><thead><tr><th>Advance No</th><th>Date</th><th class="num">Amount</th><th class="num">Adjusted</th><th class="num">Balance</th><th>Status</th></tr></thead>
                  <tbody>${data.advances
                    .map(
                      (a) => `<tr><td><a class="mono" href="#/advances/${a.id}">${esc(a.advanceNo)}</a></td>
                        <td>${fmtDate(a.advanceDate)}</td><td class="num">${money(a.amount)}</td>
                        <td class="num">${money(a.adjustedAmount)}</td><td class="num fw-700">${money(a.balance)}</td>
                        <td>${statusBadge(a.status)}</td></tr>`
                    )
                    .join('')}</tbody></table>`
              : '<div class="empty small">No advances recorded.</div>'}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Documents</h3><div class="sub">${data.documents.length} file(s)</div></div></div>
          <div class="card-body">
            ${data.documents.length
              ? `<div class="file-list">${data.documents
                  .map(
                    (d) => `<div class="file-item"><div class="ficon">${icon('file')}</div>
                      <div style="min-width:0"><div class="fname">${esc(d.fileName)}</div>
                      <div class="fmeta">${esc(d.docType)} \u00b7 ${fileSize(d.size)}</div></div>
                      <div class="factions"><a class="btn btn-sm btn-ghost" href="${d.url}" target="_blank" rel="noopener">${icon('eye')}</a></div></div>`
                  )
                  .join('')}</div>`
              : `<div class="small muted">No documents uploaded.</div>`}
            ${can('vendor.edit') ? `<button class="btn btn-sm btn-block mt-12" data-upload>${icon('upload')} Upload document</button>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Quick Actions</h3></div></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
            ${can('vendor.edit') ? `<a class="btn" href="#/vendors/${v.id}/edit">${icon('edit')} Edit vendor</a>` : ''}
            ${can('advance.create') ? `<a class="btn" href="#/advances?new=1&vendorId=${v.id}">${icon('wallet')} Record advance</a>` : ''}
            ${can('report.view') ? `<a class="btn" href="#/reports/vendor-master">${icon('chart')} Vendor reports</a>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-upload]')?.addEventListener('click', () => openUploadDialog(v, data));
  void reloadPage;
}

function openUploadDialog(vendor, data) {
  modal({
    title: 'Upload vendor document',
    subtitle: vendor.name,
    body: `<div class="field"><label>Document type</label>
        <select class="select" data-doctype>${['PAN Copy', 'GST Certificate', 'Bank Proof', 'Vendor Agreement', 'KYC Document', 'Other'].map((d) => `<option>${d}</option>`).join('')}</select></div>
      <div class="field"><label>File</label><input class="input" type="file" data-file accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx" /></div>
      <div class="small muted">Maximum 5 MB per file.</div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-upload-ok>Upload</button>`,
    onMount(el, close) {
      el.querySelector('[data-upload-ok]').addEventListener('click', async () => {
        const file = el.querySelector('[data-file]').files[0];
        if (!file) { toast('Choose a file first.', 'error'); return; }
        const ext = file.name.split('.').pop().toLowerCase();
        if (!ALLOWED_UPLOAD_EXT.includes(ext)) { toast('File type not allowed.', 'error'); return; }
        if (file.size > MAX_UPLOAD_BYTES) { toast('File exceeds 5 MB.', 'error'); return; }
        const payload = await readFileAsBase64(file);
        payload.docType = el.querySelector('[data-doctype]').value;
        try {
          await api.post(`/api/vendors/${vendor.id}/documents`, payload);
          close();
          toast('Document uploaded.');
          reloadPage();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
  void data;
}
