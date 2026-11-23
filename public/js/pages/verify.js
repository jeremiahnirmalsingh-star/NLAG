import { api } from '../api.js';
import { esc, icon, money, fmtDate, statusBadge } from '../ui.js';

export async function render(root, { token } = {}) {
  root.innerHTML = `
    <div style="min-height:100vh;background:#f4f6fa">
      <div class="empty" style="min-height:100vh;display:grid;place-items:center">
        <div><div class="small muted">Verifying approval report\u2026</div></div>
      </div>
    </div>`;

  if (!token) {
    showInvalid(root, 'No verification token was supplied.');
    return;
  }

  let data;
  try {
    data = await api.get(`/api/public/verify/${encodeURIComponent(token)}`, { silent: true });
  } catch (err) {
    showInvalid(root, err.message || 'This verification link is not valid.');
    return;
  }

  const stages = data.stages || [];
  const isApproved = data.status === 'approved';

  root.innerHTML = `
    <div style="min-height:100vh;background:linear-gradient(180deg,#0b2138 0%,#0d2742 220px,#f4f6fa 220px);padding:24px 16px 48px">
      <div style="max-width:820px;margin:0 auto">
        <div style="display:flex;align-items:center;gap:12px;color:#dbe6f2;margin-bottom:20px">
          <div class="brand-mark"><img src="/img/logo.png?v=2" alt="Logo" style="width:100%;height:100%;object-fit:contain;display:block" /></div>
          <div>
            <strong style="color:#fff;font-size:15.5px;display:block">New Life AG Church</strong>
            <span style="font-size:11.5px;color:#9fb4cb">Administration Department \u00b7 Approval Verification</span>
          </div>
          <div style="margin-left:auto;font-size:11px;color:#9fb4cb">ABMDAS</div>
        </div>

        <div class="card" style="box-shadow:0 24px 60px rgba(9,24,42,.22)">
          <div class="card-body" style="padding:26px">
            <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
              <div class="chip ${isApproved ? 'green' : 'amber'}" style="width:48px;height:48px;border-radius:12px">
                ${icon(isApproved ? 'checkCircle' : 'clock')}
              </div>
              <div style="min-width:0;flex:1">
                <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:700">
                  ${isApproved ? 'Verified approval' : 'Verification successful'}
                </div>
                <h1 style="font-size:23px;margin-top:2px">${esc(data.billNo)}</h1>
                <div class="sub">${esc(data.vendorName)} \u00b7 Invoice ${esc(data.invoiceNumber)} dated ${fmtDate(data.invoiceDate)}</div>
              </div>
              <div>${statusBadge(data.status)}</div>
            </div>

            <div class="divider"></div>

            <div class="stat-strip" style="flex-direction:column">
              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Basic amount</span><span class="v" style="font-size:15px">${money(data.invoiceAmount)}</span>
              </div>
               ${(data.taxLines && data.taxLines.length ? data.taxLines : []).map((l) => `
                              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                                <span class="k">Taxable ${money(l.taxableAmount)} @ ${l.gstRate}%${data.gstType === 'cgst_sgst' ? ` (CGST ${l.gstRate / 2}% + SGST ${l.gstRate / 2}%)` : data.gstType === 'igst' ? ' (IGST)' : ''}</span><span class="v" style="font-size:15px">${money(l.taxAmount)}</span>
                              </div>`).join('')}
               ${(!data.taxLines || !data.taxLines.length) && data.gstType === 'cgst_sgst' ? `
                              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                                <span class="k">CGST${data.gstRate ? ` (${data.gstRate / 2}%)` : ''}</span><span class="v" style="font-size:15px">${money(data.cgstAmount)}</span>
                              </div>
                              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                                <span class="k">SGST${data.gstRate ? ` (${data.gstRate / 2}%)` : ''}</span><span class="v" style="font-size:15px">${money(data.sgstAmount)}</span>
                              </div>` : ''}
               ${(!data.taxLines || !data.taxLines.length) && data.gstType === 'igst' ? `
                              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                                <span class="k">IGST${data.gstRate ? ` (${data.gstRate}%)` : ''}</span><span class="v" style="font-size:15px">${money(data.igstAmount)}</span>
                              </div>` : ''}
              ${data.gstType === 'non_gst' ? `
              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">GST treatment</span><span class="v" style="font-size:15px">Non-GST bill</span>
              </div>` : ''}
              ${data.transportType !== 'none' || data.transportAmount ? `
              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Transport charges${data.transportType === 'gst' ? ' (GST)' : data.transportType === 'non_gst' ? ' (Non-GST)' : ''}</span><span class="v" style="font-size:15px">${money(data.transportAmount)}</span>
              </div>` : ''}
              ${data.transportTaxAmount ? `
              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">GST on transport${data.transportGstRate ? ` (${data.transportGstRate}%)` : ''}</span><span class="v" style="font-size:15px">${money(data.transportTaxAmount)}</span>
              </div>` : ''}
              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Total tax</span><span class="v" style="font-size:15px">${money(data.taxAmount)}</span>
              </div>
              <div class="cell" style="display:flex;justify-content:space-between;align-items:center;background:#f6fbfa">
                <span class="k">Net amount</span><span class="v" style="font-size:16px">${money(data.netAmount)}</span>
              </div>
              ${data.advanceAdjusted ? `<div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Advance adjusted</span><span class="v" style="font-size:15px">${money(data.advanceAdjusted)}</span>
              </div>` : ''}
              ${data.retentionWithheld ? `<div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Retention withheld${data.retentionPercentage ? ` (${data.retentionPercentage}%)` : ''}</span><span class="v" style="font-size:15px">${money(data.retentionWithheld)}</span>
              </div>` : ''}
              ${data.holdWithheld ? `<div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Snag-work hold withheld</span><span class="v" style="font-size:15px">${money(data.holdWithheld)}</span>
              </div>` : ''}
              ${data.creditNoteAmount ? `<div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Credit note${data.creditNoteNumber ? ` (${esc(data.creditNoteNumber)})` : ''}</span><span class="v" style="font-size:15px">${money(data.creditNoteAmount)}</span>
              </div>` : ''}
              ${(data.advanceAdjusted || data.retentionWithheld || data.holdWithheld || data.creditNoteAmount) ? `<div class="cell" style="display:flex;justify-content:space-between;align-items:center;background:#f6fbfa">
                <span class="k">Net payable</span><span class="v" style="font-size:16px">${money(data.payableAmount)}</span>
              </div>` : ''}
              <div class="cell" style="display:flex;justify-content:space-between;align-items:center">
                <span class="k">Final approval</span>
                <span class="v" style="font-size:14px">${data.approvedAt ? fmtDate(data.approvedAt, true) : '\u2014'}</span>
              </div>
            </div>

            <div class="section-title">Approval chain</div>
            ${
              stages.length
                ? `<div class="timeline">
                    ${stages
                      .map((s) => {
                        const tone = s.status === 'approved' ? 'done' : s.status === 'rejected' ? 'rejected' : s.status === 'pending' ? 'active' : 'returned';
                        const stageIcon = s.status === 'approved' ? 'check' : s.status === 'rejected' ? 'x' : s.status === 'returned' ? 'undo' : 'clock';
                        return `<div class="timeline-item">
                          <div class="timeline-dot ${tone}">${icon(stageIcon)}</div>
                          <div class="timeline-body">
                            <div class="name">${esc(s.name)} ${statusBadge(s.status)}</div>
                            <div class="meta">${esc(s.actedBy || 'Pending decision')}${s.actedAt ? ` \u00b7 ${fmtDate(s.actedAt, true)}` : ''}</div>
                          </div>
                        </div>`;
                      })
                      .join('')}
                  </div>`
                : '<div class="small muted">The approval workflow has not started for this bill.</div>'
            }

            <div class="alert ${isApproved ? 'alert-success' : 'alert-info'} mt-16" style="margin-bottom:0">
              ${icon('shield')}
              <div>
                <b>${isApproved ? 'This bill has been digitally approved.' : 'This record exists in the ABMDAS system.'}</b>
                <div class="small">The approval details above are generated directly from the organisation's system of record and cannot be altered through this page.</div>
              </div>
            </div>
          </div>
        </div>

        <div style="text-align:center;margin-top:18px;font-size:11px;color:#7a8798">
          Verified ${fmtDate(new Date().toISOString(), true)} \u00b7 New Life AG Church \u00b7 Administration Bill Management &amp; Digital Approval System
        </div>
      </div>
    </div>`;
}

function showInvalid(root, message) {
  root.innerHTML = `
    <div style="min-height:100vh;background:linear-gradient(180deg,#0b2138 0%,#0d2742 220px,#f4f6fa 220px);padding:24px 16px 48px">
      <div style="max-width:620px;margin:0 auto">
        <div style="display:flex;align-items:center;gap:12px;color:#dbe6f2;margin-bottom:20px">
          <div class="brand-mark"><img src="/img/logo.png?v=2" alt="Logo" style="width:100%;height:100%;object-fit:contain;display:block" /></div>
          <div>
            <strong style="color:#fff;font-size:15.5px;display:block">New Life AG Church</strong>
            <span style="font-size:11.5px;color:#9fb4cb">Administration Department \u00b7 Approval Verification</span>
          </div>
        </div>

        <div class="card" style="box-shadow:0 24px 60px rgba(9,24,42,.22)">
          <div class="card-body" style="padding:32px;text-align:center">
            <div class="chip red" style="width:52px;height:52px;border-radius:14px;margin:0 auto 14px">${icon('alert')}</div>
            <h1 style="font-size:20px">Verification failed</h1>
            <p class="muted" style="margin-top:8px">${esc(message)}</p>
            <div class="help-block" style="text-align:left">
              This link may be incomplete, mistyped, or belong to a report that has been removed.
              If you scanned a QR code from a printed approval report, please contact the Administration Department
              to confirm the document's authenticity.
            </div>
            <a class="btn btn-block mt-16" href="#/">Open ABMDAS sign-in</a>
          </div>
        </div>
      </div>
    </div>`;
}
