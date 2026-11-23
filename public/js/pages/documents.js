import { api } from '../api.js';
import { can } from '../state.js';
import { withQuery } from '../router.js';
import {
  esc, icon, toast, field, serializeForm, emptyState, fileSize, fmtDate, confirmDialog,
} from '../ui.js';

/**
 * Documents attached to an entity (employee, vehicle, booking, department or user).
 * The page is deliberately generic: the caller supplies the entity in `options`
 * or as `?entityType=...&entityId=...` on the route.
 */
export async function renderDocuments(ctx, options = {}) {
  const q = ctx.route?.query || {};

  const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');
  const entityType = pick(options.entityType, q.entityType, q.entity_type);
  const entityId = pick(options.entityId, q.entityId, q.entity_id);

  const pageHead = (subtitle) => `
    <div class="page-head">
      <div><h1>Documents</h1><div class="sub">${esc(subtitle)}</div></div>
    </div>`;

  if (!entityType || !entityId) {
    ctx.view.innerHTML = `${pageHead('Attachments for the selected record')}
      <div class="card">${emptyState(
        'No record selected',
        'Open Documents from a record to view or upload its attachments.',
        '',
        'file'
      )}</div>`;
    return;
  }

  const canManage = canManageDocuments(entityType);

  async function load() {
    ctx.view.innerHTML = `${pageHead('Loading documents\u2026')}
      <div class="card"><div class="empty">Loading documents\u2026</div></div>`;

    let rows = [];
    try {
      const res = await api.get(withQuery('/api/documents', {
        entityType: String(entityType),
        entityId: String(entityId),
      }));
      rows = Array.isArray(res) ? res : ((res && (res.documents || res.items || res.data)) || []);
    } catch (err) {
      ctx.view.innerHTML = `${pageHead('Attachments for this record')}
        <div class="card">${emptyState(
          'Unable to load documents',
          err?.message || 'Check your connection and try again.',
          '<button class="btn btn-sm" type="button" data-retry>Try again</button>',
          'alert'
        )}</div>`;
      ctx.view.querySelector('[data-retry]')?.addEventListener('click', () => { void load(); });
      toast(err?.message || 'Unable to load documents.', 'error');
      return;
    }

    const uploadForm = canManage
      ? `<div class="card">
          <div class="card-head"><div><h3>Upload document</h3><div class="sub">Files are stored against this record</div></div></div>
          <div class="form-section">
            <form id="document-upload-form" class="form-grid" autocomplete="off">
              ${field({
                label: 'Title',
                name: 'title',
                value: '',
                placeholder: 'Defaults to the file name',
                span: true,
              })}
              <div class="field span-2">
                <label>File<span class="req">*</span></label>
                <input class="input" type="file" name="documentFile" accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf" required />
                <div class="hint">Choose the file to attach. The title is optional.</div>
              </div>
              <div class="field span-2" style="display:flex;justify-content:flex-end">
                <button class="btn btn-primary" type="submit" data-upload>${icon('upload')} Upload document</button>
              </div>
            </form>
          </div>
        </div>`
      : '';

    ctx.view.innerHTML = `
      ${pageHead(canManage
        ? 'Attachments for this record'
        : 'Attachments for this record \u00b7 view only')}
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Attached files</h3>
            <div class="sub">${rows.length} document${rows.length === 1 ? '' : 's'} recorded</div>
          </div></div>
          <div class="table-wrap">
            ${rows.length
              ? `<table class="tbl">
                  <thead><tr>
                    <th>Title</th><th>Kind</th><th>File name</th><th class="num">Size</th><th>Date</th>
                    ${canManage ? '<th></th>' : ''}
                  </tr></thead>
                  <tbody>${rows.map((doc) => {
                    const id = docField(doc, 'id', 'id');
                    const title = docField(doc, 'title', 'title') || docField(doc, 'fileName', 'file_name') || 'Document';
                    const kind = docField(doc, 'kind', 'kind') || 'document';
                    const fileName = docField(doc, 'fileName', 'file_name');
                    const size = docField(doc, 'sizeBytes', 'size_bytes')
                      || docField(doc, 'size', 'size')
                      || docField(doc, 'fileSize', 'file_size');
                    const date = docField(doc, 'createdAt', 'created_at')
                      || docField(doc, 'uploadedAt', 'uploaded_at')
                      || docField(doc, 'date', 'date');
                    return `<tr>
                      <td><span class="strong">${esc(title)}</span></td>
                      <td class="small">${esc(kindLabel(kind))}</td>
                      <td class="small">${esc(fileName || '\u2014')}</td>
                      <td class="num small">${fileSize(size)}</td>
                      <td class="small">${fmtDate(date)}</td>
                      ${canManage && id
                        ? `<td class="actions"><button class="btn btn-sm btn-ghost" type="button"
                              data-delete-document="${esc(id)}" data-title="${esc(title)}"
                              title="Remove document">${icon('trash')}</button></td>`
                        : ''}
                    </tr>`;
                  }).join('')}</tbody>
                </table>`
              : emptyState(
                'No documents attached',
                canManage
                  ? 'Use the upload form below to attach the first file.'
                  : 'No documents have been uploaded for this record.',
                '',
                'file'
              )}
          </div>
        </div>
        ${uploadForm}
        ${canManage ? '' : `<div class="card"><div class="card-body small muted">
          ${icon('lock')} You have view-only access to these documents.
        </div></div>`}
      </div>`;

    const form = document.getElementById('document-upload-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = form.querySelector('[name="documentFile"]')?.files?.[0];
      if (!file) {
        toast('Choose a file to upload.', 'error');
        return;
      }

      const values = serializeForm(form);
      const button = form.querySelector('[data-upload]');
      button.disabled = true;
      try {
        const data = await readAsBase64(file);
        await api.post('/api/documents', {
          entityType: String(entityType),
          entityId: String(entityId),
          kind: 'document',
          title: String(values.title || '').trim() || file.name,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          data,
        });
        toast('Document uploaded.');
        await load();
      } catch (err) {
        toast(err?.message || 'Unable to upload the document.', 'error');
        button.disabled = false;
      }
    });

    ctx.view.querySelectorAll('[data-delete-document]').forEach((button) => {
      button.addEventListener('click', async () => {
        const title = button.dataset.title || 'this document';
        const ok = await confirmDialog({
          title: 'Remove document',
          message: `Remove "${title}" from this record?`,
          confirmText: 'Remove',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/api/documents/${encodeURIComponent(button.dataset.deleteDocument)}`);
          toast('Document removed.');
          await load();
        } catch (err) {
          toast(err?.message || 'Unable to remove the document.', 'error');
        }
      });
    });
  }

  await load();
}

/** Client-side gate only; the API remains the authority. */
function canManageDocuments(entityType) {
  switch (String(entityType).toLowerCase()) {
    case 'employee':
      return can('employee.manage');
    case 'fleet_vehicle':
    case 'fleet_booking':
      return can('fleet.master.manage') || can('fleet.booking.manage');
    case 'department':
      return can('org.manage');
    case 'user':
      return can('user.manage');
    default:
      return false;
  }
}

function docField(row, camel, snake) {
  if (!row) return '';
  const value = row[camel] !== undefined && row[camel] !== null ? row[camel] : row[snake];
  return value === undefined || value === null ? '' : String(value);
}

function kindLabel(kind) {
  const key = String(kind || '').toLowerCase();
  if (key === 'document') return 'Document';
  return String(kind)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** FileReader -> data URL -> raw base64 payload expected by /api/documents. */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Unable to read the selected file.'));
    reader.readAsDataURL(file);
  });
}
