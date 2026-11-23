'use strict';

const auth = require('../auth');
const { HttpError } = require('../http');
const { round2 } = require('../util');

const BILL_JOINS = `FROM bills b
  JOIN vendors v ON v.id = b.vendor_id
  LEFT JOIN departments d ON d.id = b.department_id
  LEFT JOIN categories c ON c.id = b.category_id
  LEFT JOIN users u ON u.id = b.created_by`;

function billFilters(q, alias = 'b') {
  const where = ["b.status <> 'cancelled'"];
  const params = [];
  if (q.from) {
    where.push(`${alias}.entry_date >= ?`);
    params.push(q.from);
  }
  if (q.to) {
    where.push(`${alias}.entry_date <= ?`);
    params.push(q.to);
  }
  if (q.vendorId) {
    where.push(`${alias}.vendor_id = ?`);
    params.push(Number(q.vendorId));
  }
  if (q.departmentId) {
    where.push(`${alias}.department_id = ?`);
    params.push(Number(q.departmentId));
  }
  if (q.search) {
    where.push(`(b.bill_no LIKE ? OR b.invoice_number LIKE ? OR v.name LIKE ?)`);
    const like = `%${q.search}%`;
    params.push(like, like, like);
  }
  return { where: where.join(' AND '), params };
}

const money = { type: 'money' };

const REPORTS = {
  'bill-register': {
    title: 'Bill Register',
    description: 'All bills entered in the system.',
    columns: [
      { key: 'bill_no', label: 'Bill No' },
      { key: 'entry_date', label: 'Entry Date', type: 'date' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'invoice_date', label: 'Invoice Date', type: 'date' },
      { key: 'department_name', label: 'Department' },
      { key: 'net_amount', label: 'Net Amount', ...money },
      { key: 'advance_adjusted', label: 'Advance Adj.', ...money },
      { key: 'retention_amount', label: 'Retention', ...money },
      { key: 'retention_released_amount', label: 'Retention Released', ...money },
      { key: 'retention_withheld', label: 'Retention Withheld', ...money },
      { key: 'hold_amount', label: 'Snag Hold', ...money },
      { key: 'hold_released_amount', label: 'Hold Released', ...money },
      { key: 'hold_withheld', label: 'Hold Withheld', ...money },
      { key: 'credit_note_amount', label: 'Credit Note', ...money },
      { key: 'payable_amount', label: 'Payable', ...money },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    run(db, q) {
      const { where, params } = billFilters(q);
      return {
        sql: `SELECT b.id, b.bill_no, b.entry_date, v.name AS vendor_name, b.invoice_number,
                     b.invoice_date, COALESCE(d.name,'—') AS department_name, b.net_amount,
                     b.advance_adjusted, b.retention_amount, b.retention_released_amount,
                     ROUND(MAX(b.retention_amount - b.retention_released_amount, 0), 2) AS retention_withheld,
                     b.hold_amount, b.hold_released_amount,
                     ROUND(MAX(b.hold_amount - b.hold_released_amount, 0), 2) AS hold_withheld,
                     b.credit_note_amount,
                     ROUND(b.net_amount - b.advance_adjusted
                       - MAX(b.retention_amount - b.retention_released_amount, 0)
                       - MAX(b.hold_amount - b.hold_released_amount, 0)
                       - b.credit_note_amount, 2) AS payable_amount,
                     b.status
              ${BILL_JOINS} WHERE ${where} ORDER BY b.id DESC`,
        params,
        totals: [
          'net_amount', 'advance_adjusted', 'retention_amount', 'retention_released_amount',
          'retention_withheld', 'hold_amount', 'hold_released_amount', 'hold_withheld',
          'credit_note_amount', 'payable_amount',
        ],
      };
    },
  },
  'pending-approvals': {
    title: 'Approval Pending Report',
    description: 'Bills currently awaiting an approval decision.',
    columns: [
      { key: 'bill_no', label: 'Bill No' },
      { key: 'entry_date', label: 'Entry Date', type: 'date' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'net_amount', label: 'Net Amount', ...money },
      { key: 'submitted_at', label: 'Submitted', type: 'date' },
      { key: 'stage_name', label: 'Current Stage' },
    ],
    run(db, q) {
      const { where, params } = billFilters(q);
      return {
        sql: `SELECT b.id, b.bill_no, b.entry_date, v.name AS vendor_name, b.invoice_number,
                     b.net_amount, b.submitted_at,
                     (SELECT name FROM bill_stages bs WHERE bs.bill_id=b.id AND bs.status='pending' ORDER BY sequence LIMIT 1) AS stage_name
              ${BILL_JOINS} WHERE ${where} AND b.status = 'pending' ORDER BY b.submitted_at ASC`,
        params,
        totals: ['net_amount'],
      };
    },
  },
  'approved-bills': {
    title: 'Approved Bills Report',
    description: 'Bills that received final approval.',
    columns: [
      { key: 'bill_no', label: 'Bill No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'invoice_date', label: 'Invoice Date', type: 'date' },
      { key: 'net_amount', label: 'Net Amount', ...money },
      { key: 'advance_adjusted', label: 'Advance Adj.', ...money },
      { key: 'retention_withheld', label: 'Retention Withheld', ...money },
      { key: 'hold_withheld', label: 'Snag Hold Withheld', ...money },
      { key: 'credit_note_amount', label: 'Credit Note', ...money },
      { key: 'payable_amount', label: 'Payable', ...money },
      { key: 'approved_at', label: 'Approved On', type: 'date' },
      { key: 'handover_no', label: 'Handover No' },
    ],
    run(db, q) {
      const { where, params } = billFilters(q);
      return {
        sql: `SELECT b.id, b.bill_no, v.name AS vendor_name, b.invoice_number, b.invoice_date,
                     b.net_amount, b.advance_adjusted,
                     ROUND(MAX(b.retention_amount - b.retention_released_amount, 0), 2) AS retention_withheld,
                     ROUND(MAX(b.hold_amount - b.hold_released_amount, 0), 2) AS hold_withheld,
                     b.credit_note_amount,
                     ROUND(b.net_amount - b.advance_adjusted
                       - MAX(b.retention_amount - b.retention_released_amount, 0)
                       - MAX(b.hold_amount - b.hold_released_amount, 0)
                       - b.credit_note_amount, 2) AS payable_amount,
                     b.approved_at, h.handover_no
              ${BILL_JOINS}
              LEFT JOIN handovers h ON h.bill_id = b.id
              WHERE ${where} AND b.status = 'approved' ORDER BY b.approved_at DESC`,
        params,
        totals: ['net_amount', 'advance_adjusted', 'retention_withheld', 'hold_withheld', 'credit_note_amount', 'payable_amount'],
      };
    },
  },
  'rejected-bills': {
    title: 'Rejected Bills Report',
    description: 'Bills rejected during approval.',
    columns: [
      { key: 'bill_no', label: 'Bill No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'net_amount', label: 'Net Amount', ...money },
      { key: 'entry_date', label: 'Entry Date', type: 'date' },
      { key: 'rejected_by', label: 'Rejected By' },
      { key: 'closed_at', label: 'Rejected On', type: 'date' },
    ],
    run(db, q) {
      const { where, params } = billFilters(q);
      return {
        sql: `SELECT b.id, b.bill_no, v.name AS vendor_name, b.invoice_number, b.net_amount,
                     b.entry_date, b.closed_at,
                     (SELECT u2.name FROM bill_stages bs LEFT JOIN users u2 ON u2.id=bs.acted_by
                       WHERE bs.bill_id=b.id AND bs.status='rejected' LIMIT 1) AS rejected_by
              ${BILL_JOINS} WHERE ${where} AND b.status='rejected' ORDER BY b.closed_at DESC`,
        params,
        totals: ['net_amount'],
      };
    },
  },
  'returned-bills': {
    title: 'Returned Bills Report',
    description: 'Bills returned to the creator for correction.',
    columns: [
      { key: 'bill_no', label: 'Bill No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'net_amount', label: 'Net Amount', ...money },
      { key: 'entry_date', label: 'Entry Date', type: 'date' },
      { key: 'returned_by', label: 'Returned By' },
      { key: 'return_remarks', label: 'Remarks' },
    ],
    run(db, q) {
      const { where, params } = billFilters(q);
      return {
        sql: `SELECT b.id, b.bill_no, v.name AS vendor_name, b.invoice_number, b.net_amount, b.entry_date,
                     (SELECT u2.name FROM bill_stages bs LEFT JOIN users u2 ON u2.id=bs.acted_by
                       WHERE bs.bill_id=b.id AND bs.status='returned' ORDER BY bs.sequence DESC LIMIT 1) AS returned_by,
                     (SELECT bs.comments FROM bill_stages bs WHERE bs.bill_id=b.id AND bs.status='returned'
                       ORDER BY bs.sequence DESC LIMIT 1) AS return_remarks
              ${BILL_JOINS} WHERE ${where} AND b.status='returned' ORDER BY b.updated_at DESC`,
        params,
        totals: ['net_amount'],
      };
    },
  },
  'vendor-master': {
    title: 'Vendor Master Report',
    description: 'Complete vendor database with contact and statutory details.',
    columns: [
      { key: 'code', label: 'Vendor Code' },
      { key: 'name', label: 'Vendor Name' },
      { key: 'category', label: 'Category' },
      { key: 'contact_person', label: 'Contact Person' },
      { key: 'mobile', label: 'Mobile' },
      { key: 'email', label: 'Email' },
      { key: 'gst_number', label: 'GST Number' },
      { key: 'city', label: 'City' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    run(db, q) {
      const where = ['1=1'];
      const params = [];
      if (q.search) {
        where.push('(name LIKE ? OR code LIKE ? OR contact_person LIKE ?)');
        const like = `%${q.search}%`;
        params.push(like, like, like);
      }
      return { sql: `SELECT * FROM vendors WHERE ${where.join(' AND ')} ORDER BY name`, params };
    },
  },
  'vendor-ledger': {
    title: 'Vendor Ledger Report',
    description: 'Bill and advance transaction history per vendor.',
    columns: [
      { key: 'txn_date', label: 'Date', type: 'date' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'txn_type', label: 'Transaction' },
      { key: 'reference', label: 'Reference' },
      { key: 'particulars', label: 'Particulars' },
      { key: 'debit', label: 'Debit', ...money },
      { key: 'credit', label: 'Credit', ...money },
    ],
    run(db, q) {
      const params = [];
      let vendorFilter = '';
      if (q.vendorId) {
        vendorFilter = ' WHERE vendor_id = ?';
        params.push(Number(q.vendorId));
      }
      let dateFilter = '';
      const dateParams = [];
      if (q.from) {
        dateFilter += ' AND txn_date >= ?';
        dateParams.push(q.from);
      }
      if (q.to) {
        dateFilter += ' AND txn_date <= ?';
        dateParams.push(q.to);
      }
      return {
        sql: `SELECT * FROM (
                SELECT b.entry_date AS txn_date, b.vendor_id, v.name AS vendor_name,
                       'Bill Raised' AS txn_type, b.bill_no AS reference,
                       b.invoice_number || ' — ' || COALESCE(b.particulars,'') AS particulars,
                       b.net_amount AS debit, 0 AS credit
                  FROM bills b JOIN vendors v ON v.id = b.vendor_id
                 WHERE b.status <> 'cancelled'
                UNION ALL
                SELECT a.advance_date, a.vendor_id, v.name, 'Advance Paid', a.advance_no,
                       COALESCE(a.purpose,''), 0, a.amount
                  FROM advances a JOIN vendors v ON v.id = a.vendor_id
              ) t ${vendorFilter} ${dateFilter} ORDER BY txn_date DESC, reference`,
        params: [...params, ...dateParams],
        totals: ['debit', 'credit'],
      };
    },
  },
  'advance-register': {
    title: 'Advance Register',
    description: 'All vendor advances recorded by Administration.',
    columns: [
      { key: 'advance_no', label: 'Advance No' },
      { key: 'advance_date', label: 'Date', type: 'date' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'amount', label: 'Advance Amount', ...money },
      { key: 'adjusted_amount', label: 'Adjusted', ...money },
      { key: 'balance', label: 'Balance', ...money },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'purpose', label: 'Purpose' },
    ],
    run(db, q) {
      const where = ['1=1'];
      const params = [];
      if (q.vendorId) {
        where.push('a.vendor_id = ?');
        params.push(Number(q.vendorId));
      }
      if (q.from) {
        where.push('a.advance_date >= ?');
        params.push(q.from);
      }
      if (q.to) {
        where.push('a.advance_date <= ?');
        params.push(q.to);
      }
      if (q.search) {
        where.push('(a.advance_no LIKE ? OR v.name LIKE ?)');
        const like = `%${q.search}%`;
        params.push(like, like);
      }
      return {
        sql: `SELECT a.id, a.advance_no, a.advance_date, v.name AS vendor_name, a.amount,
                     a.adjusted_amount, (a.amount - a.adjusted_amount) AS balance, a.status, a.purpose
                FROM advances a JOIN vendors v ON v.id = a.vendor_id
               WHERE ${where.join(' AND ')} ORDER BY a.id DESC`,
        params,
        totals: ['amount', 'adjusted_amount', 'balance'],
      };
    },
  },
  'outstanding-advances': {
    title: 'Outstanding Advance Report',
    description: 'Advances with a balance still available.',
    columns: [
      { key: 'advance_no', label: 'Advance No' },
      { key: 'advance_date', label: 'Date', type: 'date' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'amount', label: 'Advance Amount', ...money },
      { key: 'adjusted_amount', label: 'Adjusted', ...money },
      { key: 'balance', label: 'Outstanding', ...money },
      { key: 'days_outstanding', label: 'Days' },
    ],
    run(db, q) {
      const params = [];
      let extra = '';
      if (q.vendorId) {
        extra = ' AND a.vendor_id = ?';
        params.push(Number(q.vendorId));
      }
      return {
        sql: `SELECT a.id, a.advance_no, a.advance_date, v.name AS vendor_name, a.amount, a.adjusted_amount,
                     (a.amount - a.adjusted_amount) AS balance,
                     CAST(julianday('now') - julianday(a.advance_date) AS INTEGER) AS days_outstanding
                FROM advances a JOIN vendors v ON v.id = a.vendor_id
               WHERE a.status NOT IN ('Closed','Fully Adjusted') AND a.amount - a.adjusted_amount > 0.004 ${extra}
               ORDER BY a.advance_date ASC`,
        params,
        totals: ['amount', 'adjusted_amount', 'balance'],
      };
    },
  },
  'adjustment-report': {
    title: 'Advance Adjustment Report',
    description: 'How advances have been utilised against bills.',
    columns: [
      { key: 'bill_no', label: 'Bill No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'advance_no', label: 'Advance No' },
      { key: 'amount', label: 'Adjusted Amount', ...money },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'created_at', label: 'Adjusted On', type: 'date' },
      { key: 'bill_status', label: 'Bill Status', type: 'status' },
    ],
    run(db, q) {
      const where = ["b.status <> 'cancelled'"];
      const params = [];
      if (q.vendorId) {
        where.push('b.vendor_id = ?');
        params.push(Number(q.vendorId));
      }
      if (q.from) {
        where.push('ba.created_at >= ?');
        params.push(q.from + 'T00:00:00.000Z');
      }
      if (q.to) {
        where.push('ba.created_at <= ?');
        params.push(q.to + 'T23:59:59.999Z');
      }
      return {
        sql: `SELECT ba.id, b.bill_no, v.name AS vendor_name, a.advance_no, ba.amount,
                     b.invoice_number, b.status AS bill_status, ba.created_at
                FROM bill_advances ba
                JOIN bills b ON b.id = ba.bill_id
                JOIN advances a ON a.id = ba.advance_id
                JOIN vendors v ON v.id = b.vendor_id
               WHERE ${where.join(' AND ')} ORDER BY ba.id DESC`,
        params,
        totals: ['amount'],
      };
    },
  },
  'handover-register': {
    title: 'Accounts Handover Register',
    description: 'Bills forwarded to the Accounts Department.',
    columns: [
      { key: 'handover_no', label: 'Handover No' },
      { key: 'bill_no', label: 'Bill No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'invoice_amount', label: 'Invoice Amount', ...money },
      { key: 'advance_adjusted', label: 'Advance Adj.', ...money },
      { key: 'retention_withheld', label: 'Retention Withheld', ...money },
      { key: 'hold_withheld', label: 'Snag Hold Withheld', ...money },
      { key: 'credit_note_amount', label: 'Credit Note', ...money },
      { key: 'payable_amount', label: 'Payable', ...money },
      { key: 'approval_date', label: 'Approval Date', type: 'date' },
      { key: 'forwarded_at', label: 'Forwarded', type: 'date' },
      { key: 'forwarded_by_name', label: 'Forwarded By' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    run(db, q) {
      const where = ['1=1'];
      const params = [];
      if (q.from) {
        where.push('h.forwarded_at >= ?');
        params.push(q.from);
      }
      if (q.to) {
        where.push('h.forwarded_at <= ?');
        params.push(q.to + 'T23:59:59.999Z');
      }
      if (q.search) {
        where.push('(h.handover_no LIKE ? OR b.bill_no LIKE ? OR v.name LIKE ?)');
        const like = `%${q.search}%`;
        params.push(like, like, like);
      }
      return {
        sql: `SELECT h.id, h.handover_no, b.bill_no, v.name AS vendor_name, b.invoice_number,
                     b.net_amount AS invoice_amount, b.advance_adjusted,
                     ROUND(MAX(b.retention_amount - b.retention_released_amount, 0), 2) AS retention_withheld,
                     ROUND(MAX(b.hold_amount - b.hold_released_amount, 0), 2) AS hold_withheld,
                     b.credit_note_amount,
                     ROUND(b.net_amount - b.advance_adjusted
                       - MAX(b.retention_amount - b.retention_released_amount, 0)
                       - MAX(b.hold_amount - b.hold_released_amount, 0)
                       - b.credit_note_amount, 2) AS payable_amount,
                     b.approved_at AS approval_date, h.forwarded_at,
                     f.name AS forwarded_by_name, r.name AS received_by_name, h.status, h.received_at
                FROM handovers h
                JOIN bills b ON b.id = h.bill_id
                JOIN vendors v ON v.id = b.vendor_id
                LEFT JOIN users f ON f.id = h.forwarded_by
                LEFT JOIN users r ON r.id = h.received_by
               WHERE ${where.join(' AND ')} ORDER BY h.id DESC`,
        params,
        totals: ['invoice_amount', 'advance_adjusted', 'retention_withheld', 'hold_withheld', 'credit_note_amount', 'payable_amount'],
      };
    },
  },
  'acknowledgment-report': {
    title: 'Accounts Acknowledgement Report',
    description: 'Handovers acknowledged by the Accounts Department.',
    columns: [
      { key: 'handover_no', label: 'Handover No' },
      { key: 'bill_no', label: 'Bill No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'invoice_number', label: 'Invoice No' },
      { key: 'invoice_amount', label: 'Amount', ...money },
      { key: 'retention_withheld', label: 'Retention Withheld', ...money },
      { key: 'hold_withheld', label: 'Snag Hold Withheld', ...money },
      { key: 'credit_note_amount', label: 'Credit Note', ...money },
      { key: 'payable_amount', label: 'Payable', ...money },
      { key: 'forwarded_at', label: 'Forwarded', type: 'date' },
      { key: 'received_by_name', label: 'Received By' },
      { key: 'received_at', label: 'Acknowledged On', type: 'date' },
      { key: 'remarks', label: 'Remarks' },
    ],
    run(db, q) {
      const where = ["h.status = 'acknowledged'"];
      const params = [];
      if (q.from) {
        where.push('h.received_at >= ?');
        params.push(q.from);
      }
      if (q.to) {
        where.push('h.received_at <= ?');
        params.push(q.to + 'T23:59:59.999Z');
      }
      return {
        sql: `SELECT h.id, h.handover_no, b.bill_no, v.name AS vendor_name, b.invoice_number,
                     b.net_amount AS invoice_amount,
                     ROUND(MAX(b.retention_amount - b.retention_released_amount, 0), 2) AS retention_withheld,
                     ROUND(MAX(b.hold_amount - b.hold_released_amount, 0), 2) AS hold_withheld,
                     b.credit_note_amount,
                     ROUND(b.net_amount - b.advance_adjusted
                       - MAX(b.retention_amount - b.retention_released_amount, 0)
                       - MAX(b.hold_amount - b.hold_released_amount, 0)
                       - b.credit_note_amount, 2) AS payable_amount,
                     h.forwarded_at, h.received_at, h.remarks,
                     r.name AS received_by_name
                FROM handovers h
                JOIN bills b ON b.id = h.bill_id
                JOIN vendors v ON v.id = b.vendor_id
                LEFT JOIN users r ON r.id = h.received_by
               WHERE ${where.join(' AND ')} ORDER BY h.received_at DESC`,
        params,
        totals: ['invoice_amount', 'retention_withheld', 'hold_withheld', 'credit_note_amount', 'payable_amount'],
      };
    },
  },

  /* ---------------- Procurement reports (Phase 3) ---------------- */
  'requisition-register': {
    title: 'Requisition Register',
    description: 'All material/service requisitions raised in procurement.',
    columns: [
      { key: 'requisition_no', label: 'Requisition No' },
      { key: 'created_at', label: 'Created', type: 'date' },
      { key: 'unit_name', label: 'Unit' },
      { key: 'department_name', label: 'Department' },
      { key: 'requirement_type', label: 'Type' },
      { key: 'purpose', label: 'Purpose' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'total_estimated', label: 'Estimated Value', ...money },
      { key: 'requested_by_name', label: 'Requested By' },
    ],
    run(db, q) {
      const where = ['r.deleted_at IS NULL'];
      const params = [];
      if (q.from) { where.push('r.created_at >= ?'); params.push(q.from); }
      if (q.to) { where.push('r.created_at <= ?'); params.push(q.to + 'T23:59:59'); }
      if (q.unitId) { where.push('r.unit_id = ?'); params.push(Number(q.unitId)); }
      if (q.status) { where.push('r.status = ?'); params.push(String(q.status)); }
      if (q.type) { where.push('r.requirement_type = ?'); params.push(String(q.type)); }
      return {
        sql: `SELECT r.requisition_no, r.created_at, u.name AS unit_name,
                     COALESCE(d.name,'—') AS department_name, r.requirement_type, r.purpose,
                     r.status,
                     COALESCE((SELECT SUM(ri.quantity * ri.estimated_unit_cost) FROM requisition_items ri WHERE ri.requisition_id = r.id),0) AS total_estimated,
                     COALESCE(ur.name,'') AS requested_by_name
              FROM requisitions r
              JOIN units u ON u.id = r.unit_id
              LEFT JOIN departments d ON d.id = r.department_id
              LEFT JOIN users ur ON ur.id = r.requested_by
              WHERE ${where.join(' AND ')}
              ORDER BY r.id DESC`,
        params,
        totals: ['total_estimated'],
      };
    },
  },
  'rfq-register': {
    title: 'RFQ Register',
    description: 'All requests for quotation issued to vendors.',
    columns: [
      { key: 'rfq_no', label: 'RFQ No' },
      { key: 'issued_at', label: 'Issued', type: 'date' },
      { key: 'unit_name', label: 'Unit' },
      { key: 'title', label: 'Title' },
      { key: 'requirement_type', label: 'Type' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'closing_date', label: 'Closing Date', type: 'date' },
      { key: 'vendor_count', label: 'Vendors' },
      { key: 'quotation_count', label: 'Quotes' },
    ],
    run(db, q) {
      const where = ['r.deleted_at IS NULL'];
      const params = [];
      if (q.from) { where.push('r.issued_at >= ?'); params.push(q.from); }
      if (q.to) { where.push('r.issued_at <= ?'); params.push(q.to + 'T23:59:59'); }
      if (q.unitId) { where.push('r.unit_id = ?'); params.push(Number(q.unitId)); }
      if (q.status) { where.push('r.status = ?'); params.push(String(q.status)); }
      return {
        sql: `SELECT r.rfq_no, r.issued_at, u.name AS unit_name, r.title, r.requirement_type, r.status,
                     r.closing_date,
                     (SELECT COUNT(*) FROM rfq_vendors rv WHERE rv.rfq_id = r.id) AS vendor_count,
                     (SELECT COUNT(*) FROM quotations q WHERE q.rfq_id = r.id AND q.deleted_at IS NULL) AS quotation_count
              FROM rfqs r
              JOIN units u ON u.id = r.unit_id
              WHERE ${where.join(' AND ')}
              ORDER BY r.id DESC`,
        params,
      };
    },
  },
  'po-register': {
    title: 'Purchase Order Register',
    description: 'All purchase orders with vendor, status and value.',
    columns: [
      { key: 'po_no', label: 'PO No' },
      { key: 'po_date', label: 'PO Date', type: 'date' },
      { key: 'unit_name', label: 'Unit' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'item_count', label: 'Lines' },
      { key: 'subtotal', label: 'Subtotal', ...money },
      { key: 'tax_amount', label: 'Tax', ...money },
      { key: 'total_amount', label: 'Total', ...money },
      { key: 'delivery_date', label: 'Delivery Date', type: 'date' },
      { key: 'rfq_no', label: 'RFQ' },
      { key: 'cs_no', label: 'Comparative' },
    ],
    run(db, q) {
      const where = ['p.deleted_at IS NULL'];
      const params = [];
      if (q.from) { where.push('p.po_date >= ?'); params.push(q.from); }
      if (q.to) { where.push('p.po_date <= ?'); params.push(q.to); }
      if (q.unitId) { where.push('p.unit_id = ?'); params.push(Number(q.unitId)); }
      if (q.status) { where.push('p.status = ?'); params.push(String(q.status)); }
      if (q.vendorId) { where.push('p.vendor_id = ?'); params.push(Number(q.vendorId)); }
      return {
        sql: `SELECT p.po_no, p.po_date, u.name AS unit_name, v.name AS vendor_name, p.status,
                     (SELECT COUNT(*) FROM po_items pi WHERE pi.po_id = p.id) AS item_count,
                     p.subtotal, p.tax_amount, p.total_amount, p.delivery_date,
                     COALESCE(r.rfq_no,'') AS rfq_no, COALESCE(c.cs_no,'') AS cs_no
              FROM purchase_orders p
              JOIN units u ON u.id = p.unit_id
              JOIN vendors v ON v.id = p.vendor_id
              LEFT JOIN rfqs r ON r.id = p.rfq_id
              LEFT JOIN comparative_statements c ON c.id = p.comparative_statement_id
              WHERE ${where.join(' AND ')}
              ORDER BY p.id DESC`,
        params,
        totals: ['subtotal', 'tax_amount', 'total_amount'],
      };
    },
  },
  'grn-register': {
    title: 'Goods Receipt Register',
    description: 'All goods receipt notes with received/accepted quantities.',
    columns: [
      { key: 'grn_no', label: 'GRN No' },
      { key: 'received_date', label: 'Received', type: 'date' },
      { key: 'po_no', label: 'PO No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'unit_name', label: 'Unit' },
      { key: 'store_name', label: 'Store' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'item_count', label: 'Lines' },
      { key: 'challan_no', label: 'Challan' },
    ],
    run(db, q) {
      const where = [];
      const params = [];
      if (q.from) { where.push('g.received_date >= ?'); params.push(q.from); }
      if (q.to) { where.push('g.received_date <= ?'); params.push(q.to); }
      if (q.unitId) { where.push('g.unit_id = ?'); params.push(Number(q.unitId)); }
      if (q.status) { where.push('g.status = ?'); params.push(String(q.status)); }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      return {
        sql: `SELECT g.grn_no, g.received_date, p.po_no, v.name AS vendor_name, u.name AS unit_name,
                     COALESCE(s.name,'—') AS store_name, g.status,
                     (SELECT COUNT(*) FROM grn_items gi WHERE gi.grn_id = g.id) AS item_count,
                     COALESCE(g.challan_no,'') AS challan_no
              FROM grns g
              JOIN purchase_orders p ON p.id = g.po_id
              JOIN vendors v ON v.id = p.vendor_id
              JOIN units u ON u.id = g.unit_id
              LEFT JOIN stores s ON s.id = g.store_id
              ${w}
              ORDER BY g.id DESC`,
        params,
      };
    },
  },
  'invoice-register': {
    title: 'Procurement Invoice Register',
    description: 'Procurement invoices with validation and ABMDAS bill linkage.',
    columns: [
      { key: 'invoice_no', label: 'Invoice No' },
      { key: 'supplier_invoice_no', label: 'Supplier Inv' },
      { key: 'supplier_invoice_date', label: 'Inv Date', type: 'date' },
      { key: 'po_no', label: 'PO No' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'net_amount', label: 'Net', ...money },
      { key: 'tax_amount', label: 'Tax', ...money },
      { key: 'total_amount', label: 'Total', ...money },
      { key: 'abmdas_bill_id', label: 'ABMDAS Bill' },
    ],
    run(db, q) {
      const where = ['i.deleted_at IS NULL'];
      const params = [];
      if (q.from) { where.push('i.supplier_invoice_date >= ?'); params.push(q.from); }
      if (q.to) { where.push('i.supplier_invoice_date <= ?'); params.push(q.to); }
      if (q.status) { where.push('i.status = ?'); params.push(String(q.status)); }
      if (q.vendorId) { where.push('p.vendor_id = ?'); params.push(Number(q.vendorId)); }
      return {
        sql: `SELECT i.invoice_no, i.supplier_invoice_no, i.supplier_invoice_date, p.po_no,
                     v.name AS vendor_name, i.status, i.net_amount, i.tax_amount, i.net_amount AS total_amount,
                     COALESCE(i.abmdas_bill_id,'') AS abmdas_bill_id
              FROM invoices i
              JOIN purchase_orders p ON p.id = i.po_id
              JOIN vendors v ON v.id = p.vendor_id
              WHERE ${where.join(' AND ')}
              ORDER BY i.id DESC`,
        params,
        totals: ['net_amount', 'tax_amount', 'total_amount'],
      };
    },
  },
  'stock-balance': {
    title: 'Stock Balance',
    description: 'Current stock quantity by store and item.',
    columns: [
      { key: 'store_name', label: 'Store' },
      { key: 'item_code', label: 'Item Code' },
      { key: 'item_name', label: 'Item' },
      { key: 'uom_code', label: 'UOM' },
      { key: 'quantity', label: 'Quantity', type: 'number' },
    ],
    run(db, q) {
      const where = [];
      const params = [];
      if (q.storeId) { where.push('sb.store_id = ?'); params.push(Number(q.storeId)); }
      if (q.itemId) { where.push('sb.item_id = ?'); params.push(Number(q.itemId)); }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      return {
        sql: `SELECT s.name AS store_name, i.item_code, i.name AS item_name, u.code AS uom_code,
                     sb.quantity
              FROM stock_balances sb
              JOIN stores s ON s.id = sb.store_id
              JOIN items i ON i.id = sb.item_id
              LEFT JOIN uoms u ON u.id = i.uom_id
              ${w}
              ORDER BY s.name, i.name`,
        params,
        totals: ['value'],
      };
    },
  },
  'stock-ledger': {
    title: 'Stock Ledger',
    description: 'Append-only stock movements with reference and balance.',
    columns: [
      { key: 'created_at', label: 'Date', type: 'date' },
      { key: 'store_name', label: 'Store' },
      { key: 'item_code', label: 'Item' },
      { key: 'transaction_type', label: 'Type' },
      { key: 'reference_type', label: 'Ref Type' },
      { key: 'reference_id', label: 'Ref ID' },
      { key: 'quantity_in', label: 'In', type: 'number' },
      { key: 'quantity_out', label: 'Out', type: 'number' },
      { key: 'balance_after', label: 'Balance', type: 'number' },
      { key: 'unit_cost', label: 'Unit Cost', ...money },
    ],
    run(db, q) {
      const where = [];
      const params = [];
      if (q.from) { where.push('sl.created_at >= ?'); params.push(q.from); }
      if (q.to) { where.push('sl.created_at <= ?'); params.push(q.to + 'T23:59:59'); }
      if (q.storeId) { where.push('sl.store_id = ?'); params.push(Number(q.storeId)); }
      if (q.itemId) { where.push('sl.item_id = ?'); params.push(Number(q.itemId)); }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      return {
        sql: `SELECT sl.created_at, s.name AS store_name, i.item_code, sl.transaction_type,
                     sl.reference_type, sl.reference_id, sl.quantity_in, sl.quantity_out,
                     sl.balance_after, sl.unit_cost
              FROM stock_ledger sl
              JOIN stores s ON s.id = sl.store_id
              JOIN items i ON i.id = sl.item_id
              ${w}
              ORDER BY sl.id DESC`,
        params,
      };
    },
  },
  'asset-register': {
    title: 'Asset Register',
    description: 'All assets with status, custodian, location and value.',
    columns: [
      { key: 'asset_code', label: 'Asset Code' },
      { key: 'asset_name', label: 'Asset' },
      { key: 'item_code', label: 'Item' },
      { key: 'unit_name', label: 'Unit' },
      { key: 'category_name', label: 'Category' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'condition', label: 'Condition' },
      { key: 'serial_no', label: 'Serial' },
      { key: 'model_no', label: 'Model' },
      { key: 'manufacturer', label: 'Make' },
      { key: 'custodian_name', label: 'Custodian' },
      { key: 'store_name', label: 'Store' },
      { key: 'purchase_date', label: 'Purchased', type: 'date' },
      { key: 'purchase_value', label: 'Value', ...money },
    ],
    run(db, q) {
      const where = ['a.deleted_at IS NULL'];
      const params = [];
      if (q.status) { where.push('a.status = ?'); params.push(String(q.status)); }
      if (q.unitId) { where.push('a.unit_id = ?'); params.push(Number(q.unitId)); }
      if (q.categoryId) { where.push('a.category_id = ?'); params.push(Number(q.categoryId)); }
      return {
        sql: `SELECT a.asset_code, a.asset_name, COALESCE(i.item_code,'') AS item_code,
                     u.name AS unit_name, COALESCE(c.name,'') AS category_name, a.status,
                     COALESCE(a.condition,'') AS condition, COALESCE(a.serial_no,'') AS serial_no,
                     COALESCE(a.model_no,'') AS model_no, COALESCE(a.manufacturer,'') AS manufacturer,
                     COALESCE(e.name,'—') AS custodian_name, COALESCE(s.name,'—') AS store_name,
                     a.purchase_date, a.purchase_value
              FROM assets a
              JOIN units u ON u.id = a.unit_id
              LEFT JOIN items i ON i.id = a.item_id
              LEFT JOIN item_categories c ON c.id = a.category_id
              LEFT JOIN employees e ON e.id = a.custodian_employee_id
              LEFT JOIN stores s ON s.id = a.store_id
              WHERE ${where.join(' AND ')}
              ORDER BY a.id DESC`,
        params,
        totals: ['purchase_value'],
      };
    },
  },
  'vendor-register': {
    title: 'Vendor Register',
    description: 'All vendors with status and evaluation summary.',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Vendor' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'gst_number', label: 'GST' },
      { key: 'po_count', label: 'POs' },
      { key: 'po_value', label: 'PO Value', ...money },
      { key: 'avg_delivery', label: 'Avg Delivery' },
      { key: 'avg_quality', label: 'Avg Quality' },
    ],
    run(db, q) {
      const where = [];
      const params = [];
      if (q.status) { where.push('v.status = ?'); params.push(String(q.status)); }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      return {
        sql: `SELECT v.code, v.name, v.status, COALESCE(v.gst_number,'') AS gst_number,
                     (SELECT COUNT(*) FROM purchase_orders p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL) AS po_count,
                     COALESCE((SELECT SUM(p.total_amount) FROM purchase_orders p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL),0) AS po_value,
                     COALESCE((SELECT AVG(ve.delivery_rating) FROM vendor_evaluations ve WHERE ve.vendor_id = v.id),0) AS avg_delivery,
                     COALESCE((SELECT AVG(ve.quality_rating) FROM vendor_evaluations ve WHERE ve.vendor_id = v.id),0) AS avg_quality
              FROM vendors v
              ${w}
              ORDER BY v.name`,
        params,
        totals: ['po_value'],
      };
    },
  },
};

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

module.exports = function registerReportRoutes(router) {
  router.get('/api/reports', async (ctx) => {
    auth.guard(ctx.user, 'report.view');
    return {
      reports: Object.entries(REPORTS).map(([key, r]) => ({
        key,
        title: r.title,
        description: r.description,
      })),
    };
  });

  router.get('/api/reports/:type', async (ctx) => {
    auth.guard(ctx.user, 'report.view');
    const def = REPORTS[ctx.params.type];
    if (!def) throw new HttpError(404, 'Unknown report.');
    const { sql, params, totals = [] } = def.run(ctx.db, ctx.query);
    let rows = ctx.db.prepare(sql).all(...params);

    const totalValues = {};
    for (const key of totals) {
      totalValues[key] = round2(rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0));
    }

    if (ctx.query.format === 'csv') {
      auth.guard(ctx.user, 'report.export');
      const header = def.columns.map((c) => c.label);
      const lines = [header.map(csvCell).join(',')];
      for (const row of rows) {
        lines.push(def.columns.map((c) => csvCell(row[c.key])).join(','));
      }
      const csv = '\uFEFF' + lines.join('\r\n');
      return {
        __raw: {
          contentType: 'text/csv; charset=utf-8',
          headers: {
            'Content-Disposition': `attachment; filename="${ctx.params.type}-${new Date().toISOString().slice(0, 10)}.csv"`,
          },
          body: csv,
        },
      };
    }

    return {
      report: { key: ctx.params.type, title: def.title, description: def.description, columns: def.columns },
      rows,
      totals: totalValues,
      count: rows.length,
      generatedAt: new Date().toISOString(),
    };
  });
};
