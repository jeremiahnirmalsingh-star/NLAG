'use strict';

/**
 * Additive schema for the procurement / inventory / asset modules.
 *
 * Rules for this file:
 *  - only CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 *  - never rename, drop or alter an existing ABMDAS table
 *  - seeds use INSERT OR IGNORE so repeated startups are safe
 */

const UOMS = [
  ['NOS', 'Numbers'],
  ['KG', 'Kilogram'],
  ['LTR', 'Litre'],
  ['MTR', 'Metre'],
  ['BOX', 'Box'],
  ['PKT', 'Packet'],
  ['SET', 'Set'],
  ['ROLL', 'Roll'],
  ['PAIR', 'Pair'],
  ['HR', 'Hour'],
  ['SVC', 'Service'],
  ['BAG', 'Bag'],
  ['CAN', 'Can'],
  ['TUBE', 'Tube'],
  ['BTL', 'Bottle'],
];

const CATEGORIES = [
  ['IC-CON-STATIONERY', 'Stationery', null, 'consumable'],
  ['IC-CON-STATIONERY-PAPER', 'Paper & Files', 'IC-CON-STATIONERY', 'consumable'],
  ['IC-CON-STATIONERY-WRITING', 'Writing Instruments', 'IC-CON-STATIONERY', 'consumable'],
  ['IC-CON-STATIONERY-PRINTER', 'Printer Consumables', 'IC-CON-STATIONERY', 'consumable'],
  ['IC-CON-STATIONERY-DESK', 'Desk Accessories', 'IC-CON-STATIONERY', 'consumable'],

  ['IC-CON-HOUSEKEEPING', 'Housekeeping Materials', null, 'consumable'],
  ['IC-CON-HOUSEKEEPING-CLEANING', 'Cleaning Supplies', 'IC-CON-HOUSEKEEPING', 'consumable'],
  ['IC-CON-HOUSEKEEPING-TOILETRIES', 'Toiletries', 'IC-CON-HOUSEKEEPING', 'consumable'],
  ['IC-CON-HOUSEKEEPING-WASTE', 'Waste Management', 'IC-CON-HOUSEKEEPING', 'consumable'],

  ['IC-CON-PANTRY', 'Pantry Items', null, 'consumable'],
  ['IC-CON-PANTRY-BEVERAGES', 'Beverages', 'IC-CON-PANTRY', 'consumable'],
  ['IC-CON-PANTRY-SNACKS', 'Snacks', 'IC-CON-PANTRY', 'consumable'],
  ['IC-CON-PANTRY-KITCHEN', 'Kitchen Supplies', 'IC-CON-PANTRY', 'consumable'],

  ['IC-CON-ELECTRICAL', 'Electrical Consumables', null, 'consumable'],
  ['IC-CON-ELECTRICAL-LAMPS', 'Lamps & Fixtures', 'IC-CON-ELECTRICAL', 'consumable'],
  ['IC-CON-ELECTRICAL-WIRING', 'Wiring & Switches', 'IC-CON-ELECTRICAL', 'consumable'],
  ['IC-CON-ELECTRICAL-PROTECTION', 'Fuses & Breakers', 'IC-CON-ELECTRICAL', 'consumable'],

  ['IC-CON-PLUMBING', 'Plumbing Consumables', null, 'consumable'],
  ['IC-CON-PLUMBING-PIPES', 'Pipes & Fittings', 'IC-CON-PLUMBING', 'consumable'],
  ['IC-CON-PLUMBING-TAPS', 'Taps & Valves', 'IC-CON-PLUMBING', 'consumable'],
  ['IC-CON-PLUMBING-SEALANTS', 'Sealants', 'IC-CON-PLUMBING', 'consumable'],

  ['IC-CON-PAINTS', 'Paints', null, 'consumable'],
  ['IC-CON-PAINTS-EMULSION', 'Emulsion', 'IC-CON-PAINTS', 'consumable'],
  ['IC-CON-PAINTS-ENAMEL', 'Enamel', 'IC-CON-PAINTS', 'consumable'],
  ['IC-CON-PAINTS-ACCESSORIES', 'Paint Accessories', 'IC-CON-PAINTS', 'consumable'],

  ['IC-CON-BATTERIES', 'Batteries', null, 'consumable'],
  ['IC-CON-CLEANING', 'Cleaning Chemicals', null, 'consumable'],
  ['IC-CON-SPARES', 'Spare Parts', null, 'consumable'],

  ['IC-CON-MAINTENANCE', 'Maintenance Materials', null, 'consumable'],
  ['IC-CON-MAINTENANCE-TOOLS', 'Tools', 'IC-CON-MAINTENANCE', 'consumable'],
  ['IC-CON-MAINTENANCE-FASTENERS', 'Fasteners', 'IC-CON-MAINTENANCE', 'consumable'],
  ['IC-CON-MAINTENANCE-SAFETY', 'Safety Equipment', 'IC-CON-MAINTENANCE', 'consumable'],

  ['IC-AST-IT', 'IT Equipment', null, 'asset'],
  ['IC-AST-IT-COMPUTERS', 'Computers', 'IC-AST-IT', 'asset'],
  ['IC-AST-IT-LAPTOPS', 'Laptops', 'IC-AST-IT', 'asset'],
  ['IC-AST-IT-PRINTERS', 'Printers', 'IC-AST-IT', 'asset'],
  ['IC-AST-IT-SERVERS', 'Servers', 'IC-AST-IT', 'asset'],
  ['IC-AST-IT-NETWORK', 'Networking Equipment', 'IC-AST-IT', 'asset'],

  ['IC-AST-FURNITURE', 'Furniture', null, 'asset'],
  ['IC-AST-FURNITURE-OFFICE', 'Office Furniture', 'IC-AST-FURNITURE', 'asset'],
  ['IC-AST-FURNITURE-SEATING', 'Seating', 'IC-AST-FURNITURE', 'asset'],
  ['IC-AST-FURNITURE-STORAGE', 'Storage', 'IC-AST-FURNITURE', 'asset'],

  ['IC-AST-VEHICLES', 'Vehicles', null, 'asset'],
  ['IC-AST-AC', 'Air Conditioners', null, 'asset'],
  ['IC-AST-UPS', 'UPS Systems', null, 'asset'],

  ['IC-AST-AV', 'Audio Visual Equipment', null, 'asset'],
  ['IC-AST-AV-CAMERAS', 'Cameras', 'IC-AST-AV', 'asset'],
  ['IC-AST-AV-DISPLAYS', 'Displays', 'IC-AST-AV', 'asset'],
  ['IC-AST-AV-SOUND', 'Sound Systems', 'IC-AST-AV', 'asset'],

  ['IC-SVC-AMC', 'AMC Contracts', null, 'service'],
  ['IC-SVC-CIVIL', 'Civil Works', null, 'service'],
  ['IC-SVC-ELECTRICAL', 'Electrical Works', null, 'service'],
  ['IC-SVC-PLUMBING', 'Plumbing Works', null, 'service'],
  ['IC-SVC-PROFESSIONAL', 'Professional Services', null, 'service'],
  ['IC-SVC-SOFTWARE', 'Software Subscription Renewals', null, 'service'],
  ['IC-SVC-CONSULTING', 'Consulting Services', null, 'service'],
];

function ensureProcurementSchema(db) {
  const now = new Date().toISOString();

  db.exec(`
    /* ------------------------------------------------------------------ */
    /* Organization hierarchy                                              */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS campuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS buildings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campus_id INTEGER NOT NULL REFERENCES campuses(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS floors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      building_id INTEGER NOT NULL REFERENCES buildings(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      UNIQUE (building_id, code)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      floor_id INTEGER NOT NULL REFERENCES floors(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      room_type TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      UNIQUE (floor_id, code)
    );

    CREATE TABLE IF NOT EXISTS cost_centers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    /* ------------------------------------------------------------------ */
    /* Employees (linked to existing users without changing them)          */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id),
      employee_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      department_id INTEGER REFERENCES departments(id),
      designation TEXT,
      email TEXT,
      mobile TEXT,
      reporting_manager_id INTEGER REFERENCES employees(id),
      unit_id INTEGER REFERENCES units(id),
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    /* One employee can serve several units, mirroring user_units. The
       employees.unit_id column remains the employee's home/default unit so
       existing records and callers keep working unchanged. */
    CREATE TABLE IF NOT EXISTS employee_units (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      PRIMARY KEY (employee_id, unit_id)
    );
    CREATE INDEX IF NOT EXISTS idx_employee_units_unit ON employee_units(unit_id, employee_id);

    /* Back-fill existing single-unit employees once, safely and repeatedly. */
    INSERT OR IGNORE INTO employee_units(employee_id, unit_id)
      SELECT id, unit_id FROM employees
       WHERE deleted_at IS NULL AND unit_id IS NOT NULL;

    /* ------------------------------------------------------------------ */
    /* Item master                                                         */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS uoms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS item_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES item_categories(id),
      item_type TEXT NOT NULL CHECK (item_type IN ('consumable','asset','service')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      store_type TEXT NOT NULL DEFAULT 'main',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS bins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      UNIQUE (store_id, code)
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      specification TEXT,
      category_id INTEGER NOT NULL REFERENCES item_categories(id),
      sub_category_id INTEGER REFERENCES item_categories(id),
      uom_id INTEGER NOT NULL REFERENCES uoms(id),
      item_type TEXT NOT NULL CHECK (item_type IN ('consumable','asset','service')),
      reorder_level REAL NOT NULL DEFAULT 0,
      min_stock REAL NOT NULL DEFAULT 0,
      max_stock REAL NOT NULL DEFAULT 0,
      standard_cost REAL NOT NULL DEFAULT 0,
      track_inventory INTEGER NOT NULL DEFAULT 1,
      track_asset INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_items_type ON items(item_type);
    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
    CREATE INDEX IF NOT EXISTS idx_items_active ON items(active);

    CREATE INDEX IF NOT EXISTS idx_branches_unit ON branches(unit_id);
    CREATE INDEX IF NOT EXISTS idx_campuses_branch ON campuses(branch_id);
    CREATE INDEX IF NOT EXISTS idx_buildings_campus ON buildings(campus_id);
    CREATE INDEX IF NOT EXISTS idx_floors_building ON floors(building_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_floor ON rooms(floor_id);
    CREATE INDEX IF NOT EXISTS idx_cost_centers_unit ON cost_centers(unit_id);
    CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
    CREATE INDEX IF NOT EXISTS idx_employees_unit ON employees(unit_id);
    CREATE INDEX IF NOT EXISTS idx_stores_unit ON stores(unit_id);
    CREATE INDEX IF NOT EXISTS idx_bins_store ON bins(store_id);

    /* ------------------------------------------------------------------ */
    /* Vendor evaluation                                                   */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS vendor_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      delivery_rating INTEGER NOT NULL DEFAULT 0 CHECK (delivery_rating BETWEEN 0 AND 5),
      quality_rating INTEGER NOT NULL DEFAULT 0 CHECK (quality_rating BETWEEN 0 AND 5),
      pricing_rating INTEGER NOT NULL DEFAULT 0 CHECK (pricing_rating BETWEEN 0 AND 5),
      service_rating INTEGER NOT NULL DEFAULT 0 CHECK (service_rating BETWEEN 0 AND 5),
      comments TEXT,
      evaluated_by INTEGER REFERENCES users(id),
      evaluated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vendor_evaluations_vendor ON vendor_evaluations(vendor_id);

    /* ------------------------------------------------------------------ */
    /* Procurement workflow (separate from ABMDAS workflow tables)         */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS procurement_workflow_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      unit_id INTEGER REFERENCES units(id),
      department_id INTEGER REFERENCES departments(id),
      requirement_type TEXT CHECK (requirement_type IN ('consumable','asset','service')),
      item_category_id INTEGER REFERENCES item_categories(id),
      min_amount REAL NOT NULL DEFAULT 0,
      max_amount REAL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS procurement_workflow_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL REFERENCES procurement_workflow_rules(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      name TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      user_id INTEGER REFERENCES users(id),
      escalation_days INTEGER NOT NULL DEFAULT 3
    );

    CREATE INDEX IF NOT EXISTS idx_proc_workflow_stages_rule ON procurement_workflow_stages(rule_id);

    /* ------------------------------------------------------------------ */
    /* Phase 1a — requisitions, approvals and inventory                    */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS requisitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_no TEXT NOT NULL UNIQUE,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      department_id INTEGER REFERENCES departments(id),
      cost_center_id INTEGER REFERENCES cost_centers(id),
      requested_by INTEGER NOT NULL REFERENCES users(id),
      requirement_type TEXT NOT NULL CHECK (requirement_type IN ('consumable','asset','service')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      purpose TEXT,
      required_by TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','pending','approved','returned','rejected','cancelled','store_verification','sourcing','issued','closed')),
      current_stage INTEGER,
      workflow_rule_id INTEGER REFERENCES procurement_workflow_rules(id),
      submitted_at TEXT,
      approved_at TEXT,
      verification_status TEXT,
      verified_by INTEGER REFERENCES users(id),
      verified_at TEXT,
      verification_remarks TEXT,
      stock_issue_id INTEGER,
      cancel_reason TEXT,
      closed_at TEXT,
      suggested_vendor_id INTEGER REFERENCES vendors(id),
      suggested_vendor_name TEXT,
      suggested_vendor_contact TEXT,
      suggested_vendor_mobile TEXT,
      suggested_vendor_email TEXT,
      suggested_vendor_address TEXT,
      suggested_vendor_notes TEXT,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      delete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requisition_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id INTEGER NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES items(id),
      item_name TEXT,
      description TEXT,
      uom_id INTEGER REFERENCES uoms(id),
      quantity REAL NOT NULL,
      estimated_unit_cost REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_inclusive INTEGER NOT NULL DEFAULT 0,
      taxable_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      estimated_total REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requisition_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id INTEGER NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      name TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','returned','skipped')),
      acted_by INTEGER REFERENCES users(id),
      acted_at TEXT,
      comments TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      bin_id INTEGER REFERENCES bins(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      quantity REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_balances
      ON stock_balances(store_id, COALESCE(bin_id, 0), item_id);

    CREATE TABLE IF NOT EXISTS stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      bin_id INTEGER REFERENCES bins(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      transaction_type TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id INTEGER,
      quantity_in REAL NOT NULL DEFAULT 0,
      quantity_out REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      balance_after REAL NOT NULL DEFAULT 0,
      transaction_date TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_no TEXT NOT NULL UNIQUE,
      requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
      unit_id INTEGER NOT NULL REFERENCES units(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      issued_to INTEGER NOT NULL REFERENCES users(id),
      issued_by INTEGER NOT NULL REFERENCES users(id),
      issued_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','acknowledged','closed')),
      acknowledged_by INTEGER REFERENCES users(id),
      acknowledged_at TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_issue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES stock_issues(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      bin_id INTEGER REFERENCES bins(id),
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      remarks TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adjustment_no TEXT NOT NULL UNIQUE,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      bin_id INTEGER REFERENCES bins(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('increase','decrease')),
      quantity REAL NOT NULL,
      reason TEXT NOT NULL,
      adjusted_by INTEGER NOT NULL REFERENCES users(id),
      adjusted_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    /* ------------------------------------------------------------------ */
    /* Phase 1b — sourcing, purchase orders, receipts and invoices         */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS rfqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_no TEXT NOT NULL UNIQUE,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      department_id INTEGER REFERENCES departments(id),
      requisition_id INTEGER REFERENCES requisitions(id),
      requirement_type TEXT NOT NULL CHECK (requirement_type IN ('consumable','asset','service')),
      title TEXT NOT NULL,
      purpose TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','issued','closed','cancelled')),
      issue_date TEXT,
      closing_date TEXT,
      terms TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      issued_at TEXT,
      closed_at TEXT,
      cancel_reason TEXT,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      delete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rfq_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      requisition_item_id INTEGER REFERENCES requisition_items(id),
      item_id INTEGER REFERENCES items(id),
      description TEXT,
      uom_id INTEGER REFERENCES uoms(id),
      quantity REAL NOT NULL,
      estimated_unit_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rfq_vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      status TEXT NOT NULL DEFAULT 'invited'
        CHECK (status IN ('invited','responded','declined','withdrawn')),
      invited_at TEXT NOT NULL,
      responded_at TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (rfq_id, vendor_id)
    );

    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_no TEXT NOT NULL UNIQUE,
      rfq_id INTEGER NOT NULL REFERENCES rfqs(id),
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      quotation_date TEXT NOT NULL,
      valid_until TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      delivery_days INTEGER NOT NULL DEFAULT 0,
      payment_terms TEXT,
      warranty_terms TEXT,
      remarks TEXT,
      status TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','shortlisted','rejected','awarded','withdrawn')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      delete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
      rfq_item_id INTEGER REFERENCES rfq_items(id),
      item_id INTEGER REFERENCES items(id),
      description TEXT,
      uom_id INTEGER REFERENCES uoms(id),
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_inclusive INTEGER NOT NULL DEFAULT 0,
      taxable_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      delivery_days INTEGER NOT NULL DEFAULT 0,
      remarks TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comparative_statements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cs_no TEXT NOT NULL UNIQUE,
      rfq_id INTEGER NOT NULL REFERENCES rfqs(id),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','pending','approved','rejected','cancelled')),
      recommended_quotation_id INTEGER REFERENCES quotations(id),
      recommendation_notes TEXT,
      total_quoted REAL NOT NULL DEFAULT 0,
      prepared_by INTEGER NOT NULL REFERENCES users(id),
      prepared_at TEXT NOT NULL,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_no TEXT NOT NULL UNIQUE,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      department_id INTEGER REFERENCES departments(id),
      requisition_id INTEGER REFERENCES requisitions(id),
      rfq_id INTEGER REFERENCES rfqs(id),
      comparative_statement_id INTEGER REFERENCES comparative_statements(id),
      quotation_id INTEGER REFERENCES quotations(id),
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      po_date TEXT NOT NULL,
      delivery_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','issued','partially_received','received','closed','cancelled')),
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      freight_charges REAL NOT NULL DEFAULT 0,
      loading_charges REAL NOT NULL DEFAULT 0,
      other_charges REAL NOT NULL DEFAULT 0,
      payment_terms TEXT,
      delivery_terms TEXT,
      terms TEXT,
      notes TEXT,
      revision_no INTEGER NOT NULL DEFAULT 0,
      issued_by INTEGER REFERENCES users(id),
      issued_at TEXT,
      closed_at TEXT,
      cancelled_by INTEGER REFERENCES users(id),
      cancelled_at TEXT,
      cancel_reason TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      delete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS po_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      requisition_item_id INTEGER REFERENCES requisition_items(id),
      item_id INTEGER REFERENCES items(id),
      description TEXT,
      model_no TEXT,
      make TEXT,
      uom_id INTEGER REFERENCES uoms(id),
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_inclusive INTEGER NOT NULL DEFAULT 0,
      taxable_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      received_quantity REAL NOT NULL DEFAULT 0,
      rejected_quantity REAL NOT NULL DEFAULT 0,
      invoiced_quantity REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS po_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      revision_no INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      reason TEXT,
      revised_by INTEGER NOT NULL REFERENCES users(id),
      revised_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    /* Optional vendor-facing reference photographs. Rows are soft-deleted so a
       removed photo stays in the audit trail; files remain on disk. */
    CREATE TABLE IF NOT EXISTS po_reference_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES po_items(id) ON DELETE SET NULL,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      caption TEXT NOT NULL DEFAULT '',
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_po_reference_photos_po
      ON po_reference_photos(po_id, deleted_at);

    CREATE TABLE IF NOT EXISTS grns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_no TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      unit_id INTEGER NOT NULL REFERENCES units(id),
      store_id INTEGER REFERENCES stores(id),
      received_date TEXT NOT NULL,
      received_by INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','posted','cancelled')),
      challan_no TEXT,
      challan_date TEXT,
      vehicle_no TEXT,
      remarks TEXT,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      excess_authorized INTEGER NOT NULL DEFAULT 0,
      posted_at TEXT,
      cancelled_by INTEGER REFERENCES users(id),
      cancelled_at TEXT,
      cancel_reason TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grn_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id INTEGER NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
      po_item_id INTEGER NOT NULL REFERENCES po_items(id),
      item_id INTEGER REFERENCES items(id),
      bin_id INTEGER REFERENCES bins(id),
      ordered_quantity REAL NOT NULL DEFAULT 0,
      received_quantity REAL NOT NULL DEFAULT 0,
      accepted_quantity REAL NOT NULL DEFAULT 0,
      rejected_quantity REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_inclusive INTEGER NOT NULL DEFAULT 0,
      taxable_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      remarks TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT NOT NULL UNIQUE,
      supplier_invoice_no TEXT NOT NULL,
      supplier_invoice_date TEXT NOT NULL,
      po_id INTEGER REFERENCES purchase_orders(id),
      grn_id INTEGER REFERENCES grns(id),
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      unit_id INTEGER NOT NULL REFERENCES units(id),
      department_id INTEGER REFERENCES departments(id),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','validated','billed','rejected','cancelled')),
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0,
      gst_type TEXT NOT NULL DEFAULT 'cgst_sgst'
        CHECK (gst_type IN ('cgst_sgst','igst','non_gst')),
      gst_rate REAL NOT NULL DEFAULT 0,
      cgst_amount REAL NOT NULL DEFAULT 0,
      sgst_amount REAL NOT NULL DEFAULT 0,
      igst_amount REAL NOT NULL DEFAULT 0,
      due_date TEXT,
      remarks TEXT,
      validated_by INTEGER REFERENCES users(id),
      validated_at TEXT,
      validation_remarks TEXT,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at TEXT,
      rejection_reason TEXT,
      abmdas_bill_id INTEGER REFERENCES bills(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id),
      delete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES po_items(id),
      grn_item_id INTEGER REFERENCES grn_items(id),
      item_id INTEGER REFERENCES items(id),
      description TEXT,
      uom_id INTEGER REFERENCES uoms(id),
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_inclusive INTEGER NOT NULL DEFAULT 0,
      taxable_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requisitions_unit ON requisitions(unit_id, status);
    CREATE INDEX IF NOT EXISTS idx_requisitions_requester ON requisitions(requested_by);
    CREATE INDEX IF NOT EXISTS idx_requisition_items_req ON requisition_items(requisition_id);
    CREATE INDEX IF NOT EXISTS idx_requisition_stages_req ON requisition_stages(requisition_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_stock_balances_item ON stock_balances(item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_ledger_store_item ON stock_ledger(store_id, item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_issues_req ON stock_issues(requisition_id);
    CREATE INDEX IF NOT EXISTS idx_stock_issue_items_issue ON stock_issue_items(issue_id);
    CREATE INDEX IF NOT EXISTS idx_stock_adjustments_store ON stock_adjustments(store_id, item_id);
    CREATE INDEX IF NOT EXISTS idx_rfqs_unit ON rfqs(unit_id, status);
    CREATE INDEX IF NOT EXISTS idx_rfqs_requisition ON rfqs(requisition_id);
    CREATE INDEX IF NOT EXISTS idx_rfq_items_rfq ON rfq_items(rfq_id);
    CREATE INDEX IF NOT EXISTS idx_rfq_vendors_rfq ON rfq_vendors(rfq_id);
    CREATE INDEX IF NOT EXISTS idx_quotations_rfq ON quotations(rfq_id);
    CREATE INDEX IF NOT EXISTS idx_quotations_vendor ON quotations(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_quotation_items_quote ON quotation_items(quotation_id);
    CREATE INDEX IF NOT EXISTS idx_comparative_rfq ON comparative_statements(rfq_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_unit ON purchase_orders(unit_id, status);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id);
    CREATE INDEX IF NOT EXISTS idx_po_revisions_po ON po_revisions(po_id, revision_no);
    CREATE INDEX IF NOT EXISTS idx_grns_po ON grns(po_id);
    CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON grn_items(grn_id);
    CREATE INDEX IF NOT EXISTS idx_grn_items_po_item ON grn_items(po_item_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices(po_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

    /* ------------------------------------------------------------------ */
    /* Phase 2 — asset lifecycle                                           */
    /* ------------------------------------------------------------------ */
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_code TEXT NOT NULL UNIQUE,
      asset_name TEXT NOT NULL,
      item_id INTEGER REFERENCES items(id),
      category_id INTEGER REFERENCES item_categories(id),
      unit_id INTEGER NOT NULL REFERENCES units(id),
      department_id INTEGER REFERENCES departments(id),
      store_id INTEGER REFERENCES stores(id),
      bin_id INTEGER REFERENCES bins(id),
      room_id INTEGER REFERENCES rooms(id),
      custodian_employee_id INTEGER REFERENCES employees(id),
      vendor_id INTEGER REFERENCES vendors(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      po_item_id INTEGER REFERENCES po_items(id),
      grn_id INTEGER REFERENCES grns(id),
      grn_item_id INTEGER REFERENCES grn_items(id),
      invoice_id INTEGER REFERENCES invoices(id),
      serial_no TEXT,
      model_no TEXT,
      manufacturer TEXT,
      purchase_date TEXT,
      purchase_value REAL NOT NULL DEFAULT 0,
      warranty_start TEXT,
      warranty_end TEXT,
      status TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('ordered','received','created','allocated','in_use','under_maintenance',
                          'under_repair','transferred','missing','disposed')),
      condition TEXT,
      qr_payload TEXT,
      barcode_value TEXT,
      remarks TEXT,
      insurance_policy_no TEXT,
      insurer TEXT,
      insurance_premium REAL NOT NULL DEFAULT 0,
      insurance_expiry_date TEXT,
      insurance_remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS asset_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      department_id INTEGER REFERENCES departments(id),
      store_id INTEGER REFERENCES stores(id),
      bin_id INTEGER REFERENCES bins(id),
      room_id INTEGER REFERENCES rooms(id),
      allocated_at TEXT NOT NULL,
      allocated_by INTEGER REFERENCES users(id),
      returned_at TEXT,
      returned_by INTEGER REFERENCES users(id),
      remarks TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      from_store_id INTEGER REFERENCES stores(id),
      from_bin_id INTEGER REFERENCES bins(id),
      from_room_id INTEGER REFERENCES rooms(id),
      from_custodian_id INTEGER REFERENCES employees(id),
      to_store_id INTEGER REFERENCES stores(id),
      to_bin_id INTEGER REFERENCES bins(id),
      to_room_id INTEGER REFERENCES rooms(id),
      to_custodian_id INTEGER REFERENCES employees(id),
      transferred_at TEXT NOT NULL,
      reason TEXT,
      remarks TEXT,
      transferred_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      maintenance_type TEXT NOT NULL DEFAULT 'preventive'
        CHECK (maintenance_type IN ('preventive','corrective','inspection','calibration','other')),
      vendor_id INTEGER REFERENCES vendors(id),
      cost REAL NOT NULL DEFAULT 0,
      scheduled_date TEXT NOT NULL,
      completed_date TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
      description TEXT,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      verification_date TEXT NOT NULL,
      verified_by INTEGER REFERENCES users(id),
      location_match INTEGER NOT NULL DEFAULT 1,
      condition TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_disposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      method TEXT NOT NULL DEFAULT 'scrap'
        CHECK (method IN ('sale','scrap','donation','write_off','return_to_vendor','other')),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','disposed','cancelled')),
      requested_by INTEGER REFERENCES users(id),
      requested_at TEXT NOT NULL,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      disposed_at TEXT,
      rejection_reason TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      label_type TEXT NOT NULL DEFAULT 'both'
        CHECK (label_type IN ('qr','barcode','both')),
      printed_at TEXT NOT NULL,
      printed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    /* Asset details captured at goods receipt time (one row per GRN line). */
    CREATE TABLE IF NOT EXISTS grn_item_asset_details (
      grn_item_id INTEGER PRIMARY KEY REFERENCES grn_items(id) ON DELETE CASCADE,
      model_no TEXT,
      manufacturer TEXT,
      serial_numbers TEXT,
      warranty_start TEXT,
      warranty_end TEXT,
      condition TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /* Phase 5a — item master v2 (additive; the items table itself is unchanged). */
    CREATE TABLE IF NOT EXISTS item_details (
      item_id INTEGER PRIMARY KEY REFERENCES items(id),
      brand TEXT,
      model_no TEXT,
      manufacturer TEXT,
      hsn_code TEXT,
      gst_rate REAL NOT NULL DEFAULT 0,
      tax_inclusive INTEGER NOT NULL DEFAULT 0,
      default_discount_percent REAL NOT NULL DEFAULT 0,
      default_discount_amount REAL NOT NULL DEFAULT 0,
      moq REAL NOT NULL DEFAULT 0,
      reorder_qty REAL NOT NULL DEFAULT 0,
      lead_time_days INTEGER NOT NULL DEFAULT 0,
      pack_size REAL NOT NULL DEFAULT 1,
      pack_description TEXT,
      safety_stock REAL NOT NULL DEFAULT 0,
      last_purchase_cost REAL NOT NULL DEFAULT 0,
      color TEXT,
      capacity TEXT,
      power_rating TEXT,
      configuration_details TEXT,
      make TEXT,
      expiry_tracking INTEGER NOT NULL DEFAULT 0,
      shelf_life_days INTEGER NOT NULL DEFAULT 0,
      amc_vendor_id INTEGER REFERENCES vendors(id),
      amc_start_date TEXT,
      amc_end_date TEXT,
      insurance_required INTEGER NOT NULL DEFAULT 0,
      compliance_cert_required INTEGER NOT NULL DEFAULT 0,
      default_store_id INTEGER REFERENCES stores(id),
      storage_conditions TEXT,
      rack_number TEXT,
      bin_location TEXT,
      approval_required INTEGER NOT NULL DEFAULT 0,
      approval_matrix_id INTEGER REFERENCES procurement_workflow_rules(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /* Phase 5c — UOM conversions per item (additive). */
    CREATE TABLE IF NOT EXISTS item_uom_conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      from_uom_id INTEGER NOT NULL REFERENCES uoms(id),
      to_uom_id INTEGER NOT NULL REFERENCES uoms(id),
      conversion_factor REAL NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (item_id, from_uom_id, to_uom_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_uom_conv_item ON item_uom_conversions(item_id);
    CREATE TABLE IF NOT EXISTS item_vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      vendor_item_code TEXT,
      unit_cost REAL NOT NULL DEFAULT 0,
      lead_time_days INTEGER NOT NULL DEFAULT 0,
      is_preferred INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (item_id, vendor_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_vendors_item ON item_vendors(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_vendors_vendor ON item_vendors(vendor_id);
    CREATE TABLE IF NOT EXISTS item_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      kind TEXT NOT NULL CHECK (kind IN ('image','datasheet','compliance')),
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_attachments_item ON item_attachments(item_id, kind);

    /* Phase 5b — asset-class defaults and item-level overrides (additive). */
    CREATE TABLE IF NOT EXISTS asset_class_defaults (
      category_id INTEGER PRIMARY KEY REFERENCES item_categories(id),
      expense_classification TEXT NOT NULL DEFAULT 'asset' CHECK (expense_classification IN ('asset','expense')),
      budget_category TEXT,
      depreciation_method TEXT NOT NULL DEFAULT 'straight_line'
        CHECK (depreciation_method IN ('straight_line','written_down_value','not_depreciated')),
      useful_life_years INTEGER NOT NULL DEFAULT 5,
      depreciation_applicable INTEGER NOT NULL DEFAULT 1,
      warranty_months INTEGER NOT NULL DEFAULT 0,
      amc_applicable INTEGER NOT NULL DEFAULT 0,
      serial_required INTEGER NOT NULL DEFAULT 0,
      asset_tag_required INTEGER NOT NULL DEFAULT 1,
      default_department_id INTEGER REFERENCES departments(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_asset_settings (
      item_id INTEGER PRIMARY KEY REFERENCES items(id),
      expense_classification TEXT CHECK (expense_classification IS NULL OR expense_classification IN ('asset','expense')),
      budget_category TEXT,
      depreciation_method TEXT
        CHECK (depreciation_method IS NULL OR depreciation_method IN ('straight_line','written_down_value','not_depreciated')),
      useful_life_years INTEGER,
      depreciation_applicable INTEGER,
      warranty_months INTEGER,
      amc_applicable INTEGER,
      serial_required INTEGER,
      asset_tag_required INTEGER,
      default_department_id INTEGER REFERENCES departments(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /* Parent/child assets: component templates on asset items and instantiated
       component rows on each asset. Counts are stored per component row. */
    CREATE TABLE IF NOT EXISTS item_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_item_id INTEGER NOT NULL REFERENCES items(id),
      component_item_id INTEGER NOT NULL REFERENCES items(id),
      quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (parent_item_id, component_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_components_parent ON item_components(parent_item_id, active);
    CREATE INDEX IF NOT EXISTS idx_item_components_item ON item_components(component_item_id);

    CREATE TABLE IF NOT EXISTS asset_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_asset_id INTEGER NOT NULL REFERENCES assets(id),
      component_item_id INTEGER NOT NULL REFERENCES items(id),
      quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
      serial_no TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (parent_asset_id, component_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_components_parent ON asset_components(parent_asset_id, active);
    CREATE INDEX IF NOT EXISTS idx_asset_components_item ON asset_components(component_item_id);

    CREATE INDEX IF NOT EXISTS idx_assets_unit_status ON assets(unit_id, status);
    CREATE INDEX IF NOT EXISTS idx_assets_item ON assets(item_id);
    CREATE INDEX IF NOT EXISTS idx_assets_custodian ON assets(custodian_employee_id);
    CREATE INDEX IF NOT EXISTS idx_assets_grn ON assets(grn_id);

    CREATE TABLE IF NOT EXISTS service_acceptances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sa_no TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      unit_id INTEGER NOT NULL REFERENCES units(id),
      accepted_date TEXT NOT NULL,
      accepted_by INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('accepted','cancelled')),
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS service_acceptance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sa_id INTEGER NOT NULL REFERENCES service_acceptances(id) ON DELETE CASCADE,
      po_item_id INTEGER NOT NULL REFERENCES po_items(id),
      item_id INTEGER REFERENCES items(id),
      accepted_quantity REAL NOT NULL DEFAULT 0,
      remarks TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asset_allocations_asset ON asset_allocations(asset_id, returned_at);
    CREATE INDEX IF NOT EXISTS idx_asset_transfers_asset ON asset_transfers(asset_id);
    CREATE INDEX IF NOT EXISTS idx_asset_maintenance_asset ON asset_maintenance(asset_id, status);
    CREATE INDEX IF NOT EXISTS idx_asset_verifications_asset ON asset_verifications(asset_id);
    CREATE INDEX IF NOT EXISTS idx_asset_disposals_asset ON asset_disposals(asset_id, status);
    CREATE INDEX IF NOT EXISTS idx_asset_labels_asset ON asset_labels(asset_id);
  `);

  const insertUom = db.prepare('INSERT OR IGNORE INTO uoms(code, name) VALUES (?,?)');
  for (const [code, name] of UOMS) insertUom.run(code, name);

  const findCategory = db.prepare('SELECT id FROM item_categories WHERE code = ?');
  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO item_categories(code, name, parent_id, item_type, active, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?)`
  );
  for (const [code, name, parentCode, itemType] of CATEGORIES) {
    const parent = parentCode ? findCategory.get(parentCode) : null;
    insertCategory.run(code, name, parent ? parent.id : null, itemType, now, now);
  }

  /* Default global procurement approval workflow. Repeat-safe: only seeded
     when no global rule exists, so administrator edits are never overwritten. */
  const globalRule = db
    .prepare(
      `SELECT id FROM procurement_workflow_rules
        WHERE unit_id IS NULL AND department_id IS NULL AND requirement_type IS NULL
          AND item_category_id IS NULL AND min_amount = 0 AND max_amount IS NULL
        LIMIT 1`
    )
    .get();
  if (!globalRule) {
    const rule = db
      .prepare(
        `INSERT INTO procurement_workflow_rules(name, unit_id, department_id, requirement_type,
           item_category_id, min_amount, max_amount, active, created_at, updated_at)
         VALUES (?,NULL,NULL,NULL,NULL,0,NULL,1,?,?)`
      )
      .run('Default Procurement Approval', now, now);
    const ruleId = Number(rule.lastInsertRowid);
    const deptRole = db.prepare("SELECT id FROM roles WHERE code = 'department_head'").get();
    const procRole = db.prepare("SELECT id FROM roles WHERE code = 'procurement_officer'").get();
    const insertStage = db.prepare(
      `INSERT INTO procurement_workflow_stages(rule_id, sequence, name, role_id, user_id, escalation_days)
       VALUES (?,?,?,?,NULL,3)`
    );
    if (deptRole) insertStage.run(ruleId, 1, 'Departmental Approval', deptRole.id);
    if (procRole) insertStage.run(ruleId, 2, 'Procurement Approval', procRole.id);
  }

  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase0.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase1a.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase1b.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase2.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase5a.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase5b.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  /* Lightweight migration for databases created before Phase 5c. */
  const existingCols = new Set(
    db.prepare('PRAGMA table_info(item_details)').all().map((r) => r.name)
  );
  const newCols = {
    color: 'TEXT',
    capacity: 'TEXT',
    power_rating: 'TEXT',
    configuration_details: 'TEXT',
    make: 'TEXT',
    expiry_tracking: 'INTEGER NOT NULL DEFAULT 0',
    shelf_life_days: 'INTEGER NOT NULL DEFAULT 0',
    amc_vendor_id: 'INTEGER REFERENCES vendors(id)',
    amc_start_date: 'TEXT',
    amc_end_date: 'TEXT',
    insurance_required: 'INTEGER NOT NULL DEFAULT 0',
    compliance_cert_required: 'INTEGER NOT NULL DEFAULT 0',
    default_store_id: 'INTEGER REFERENCES stores(id)',
    storage_conditions: 'TEXT',
  };
  for (const [name, def] of Object.entries(newCols)) {
    if (!existingCols.has(name)) {
      db.exec(`ALTER TABLE item_details ADD COLUMN ${name} ${def}`);
    }
  }

  /* Migration: Phase 5f — insurance on assets, storage/approval on item_details. */
  const mig5f = db.prepare("SELECT value FROM settings WHERE key = 'migration.phase5f.v1'").get();
  if (!mig5f) {
    const assetCols = new Set(db.prepare('PRAGMA table_info(assets)').all().map((r) => r.name));
    const assetNew = {
      insurance_policy_no: 'TEXT',
      insurer: 'TEXT',
      insurance_premium: 'REAL NOT NULL DEFAULT 0',
      insurance_expiry_date: 'TEXT',
      insurance_remarks: 'TEXT',
    };
    for (const [name, def] of Object.entries(assetNew)) {
      if (!assetCols.has(name)) db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${def}`);
    }

    const detailCols = new Set(db.prepare('PRAGMA table_info(item_details)').all().map((r) => r.name));
    const detailNew = {
      rack_number: 'TEXT',
      bin_location: 'TEXT',
      approval_required: 'INTEGER NOT NULL DEFAULT 0',
      approval_matrix_id: 'INTEGER REFERENCES procurement_workflow_rules(id)',
    };
    for (const [name, def] of Object.entries(detailNew)) {
      if (!detailCols.has(name)) db.exec(`ALTER TABLE item_details ADD COLUMN ${name} ${def}`);
    }

    db.prepare("INSERT INTO settings(key, value) VALUES ('migration.phase5f.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  }

  /* Migration: free-text item names on requisition lines (items outside the master). */
  const migReqName = db.prepare("SELECT value FROM settings WHERE key = 'migration.requisition_item_name.v1'").get();
  if (!migReqName) {
    const reqCols = new Set(db.prepare('PRAGMA table_info(requisition_items)').all().map((r) => r.name));
    if (!reqCols.has('item_name')) {
      db.exec('ALTER TABLE requisition_items ADD COLUMN item_name TEXT');
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.requisition_item_name.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Migration: optional vendor suggested by the requestor on a requisition. */
  const migReqVendor = db.prepare("SELECT value FROM settings WHERE key = 'migration.requisition_suggested_vendor.v1'").get();
  if (!migReqVendor) {
    const reqHeadCols = new Set(db.prepare('PRAGMA table_info(requisitions)').all().map((r) => r.name));
    const vendorCols = {
      suggested_vendor_name: 'TEXT',
      suggested_vendor_contact: 'TEXT',
      suggested_vendor_mobile: 'TEXT',
      suggested_vendor_email: 'TEXT',
      suggested_vendor_address: 'TEXT',
      suggested_vendor_notes: 'TEXT',
    };
    for (const [name, def] of Object.entries(vendorCols)) {
      if (!reqHeadCols.has(name)) db.exec(`ALTER TABLE requisitions ADD COLUMN ${name} ${def}`);
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.requisition_suggested_vendor.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Migration: optional registered vendor suggested by the requestor. */
  const migReqVendorId = db.prepare("SELECT value FROM settings WHERE key = 'migration.requisition_suggested_vendor_id.v1'").get();
  if (!migReqVendorId) {
    const reqHeadCols = new Set(db.prepare('PRAGMA table_info(requisitions)').all().map((r) => r.name));
    if (!reqHeadCols.has('suggested_vendor_id')) db.exec('ALTER TABLE requisitions ADD COLUMN suggested_vendor_id INTEGER REFERENCES vendors(id)');
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.requisition_suggested_vendor_id.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Migration: extend item_attachments kind CHECK to include 'compliance'. */
  const migCheck = db.prepare("SELECT value FROM settings WHERE key = 'migration.item_attachments_kind.v1'").get();
  if (!migCheck) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS item_attachments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL REFERENCES items(id),
          kind TEXT NOT NULL CHECK (kind IN ('image','datasheet','compliance')),
          file_name TEXT NOT NULL,
          stored_name TEXT NOT NULL,
          mime_type TEXT,
          size INTEGER NOT NULL DEFAULT 0,
          uploaded_by INTEGER REFERENCES users(id),
          uploaded_at TEXT NOT NULL,
          deleted_at TEXT,
          deleted_by INTEGER REFERENCES users(id)
        );
        INSERT INTO item_attachments_new SELECT * FROM item_attachments;
        DROP TABLE item_attachments;
        ALTER TABLE item_attachments_new RENAME TO item_attachments;
        CREATE INDEX IF NOT EXISTS idx_item_attachments_item ON item_attachments(item_id, kind);
      `);
    } catch (e) {
      /* If migration fails (e.g., table doesn't exist yet), ignore. */
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.item_attachments_kind.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Migration: PO line item details (model no, make, discount) and PO charges. */
  const migPoLine = db.prepare("SELECT value FROM settings WHERE key = 'migration.po_line_details.v1'").get();
  if (!migPoLine) {
    const poCols = new Set(db.prepare('PRAGMA table_info(purchase_orders)').all().map((r) => r.name));
    if (!poCols.has('freight_charges')) db.exec('ALTER TABLE purchase_orders ADD COLUMN freight_charges REAL NOT NULL DEFAULT 0');
    if (!poCols.has('loading_charges')) db.exec('ALTER TABLE purchase_orders ADD COLUMN loading_charges REAL NOT NULL DEFAULT 0');
    if (!poCols.has('other_charges')) db.exec('ALTER TABLE purchase_orders ADD COLUMN other_charges REAL NOT NULL DEFAULT 0');
    const poItemCols = new Set(db.prepare('PRAGMA table_info(po_items)').all().map((r) => r.name));
    if (!poItemCols.has('model_no')) db.exec('ALTER TABLE po_items ADD COLUMN model_no TEXT');
    if (!poItemCols.has('make')) db.exec('ALTER TABLE po_items ADD COLUMN make TEXT');
    if (!poItemCols.has('discount_percent')) db.exec('ALTER TABLE po_items ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0');
    if (!poItemCols.has('discount_amount')) db.exec('ALTER TABLE po_items ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0');
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.po_line_details.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Migration: tax-inclusive pricing and direct discounts across all documents. */
  const migTaxDiscount = db.prepare("SELECT value FROM settings WHERE key = 'migration.tax_discount_options.v1'").get();
  if (!migTaxDiscount) {
    const addCols = (table, columns) => {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
      for (const [name, definition] of Object.entries(columns)) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    addCols('item_details', {
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
      default_discount_percent: 'REAL NOT NULL DEFAULT 0',
      default_discount_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('requisitions', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('requisition_items', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
      tax_rate: 'REAL NOT NULL DEFAULT 0',
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
      taxable_amount: 'REAL NOT NULL DEFAULT 0',
      tax_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('quotations', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('quotation_items', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
      taxable_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('purchase_orders', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('po_items', {
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
      taxable_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('grns', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('grn_items', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
      tax_rate: 'REAL NOT NULL DEFAULT 0',
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
      taxable_amount: 'REAL NOT NULL DEFAULT 0',
      tax_amount: 'REAL NOT NULL DEFAULT 0',
      total_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('invoices', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('invoice_items', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
      taxable_amount: 'REAL NOT NULL DEFAULT 0',
    });
    addCols('bills', {
      discount_percent: 'REAL NOT NULL DEFAULT 0',
      discount_amount: 'REAL NOT NULL DEFAULT 0',
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
    });
    addCols('bill_tax_lines', {
      tax_inclusive: 'INTEGER NOT NULL DEFAULT 0',
    });
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.tax_discount_options.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Migration: delivery address blocks, round-off and general terms.
   * Additive and repeat-safe: every column is only added when missing, and
   * the whole block runs once per database, keyed by the setting below. */
  const migDeliveryRoundoff = db
    .prepare("SELECT value FROM settings WHERE key = 'migration.delivery_roundoff_terms.v1'")
    .get();
  if (!migDeliveryRoundoff) {
    const addCols = (table, columns) => {
      const existing = new Set(
        db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
      );
      for (const [name, definition] of Object.entries(columns)) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };

    addCols('units', {
      address_line1: "TEXT NOT NULL DEFAULT ''",
      address_line2: "TEXT NOT NULL DEFAULT ''",
      city: "TEXT NOT NULL DEFAULT ''",
      state: "TEXT NOT NULL DEFAULT ''",
      pincode: "TEXT NOT NULL DEFAULT ''",
      phone: "TEXT NOT NULL DEFAULT ''",
      email: "TEXT NOT NULL DEFAULT ''",
    });

    addCols('stores', {
      address_line1: "TEXT NOT NULL DEFAULT ''",
      address_line2: "TEXT NOT NULL DEFAULT ''",
      city: "TEXT NOT NULL DEFAULT ''",
      state: "TEXT NOT NULL DEFAULT ''",
      pincode: "TEXT NOT NULL DEFAULT ''",
      incharge_name: "TEXT NOT NULL DEFAULT ''",
      incharge_designation: "TEXT NOT NULL DEFAULT ''",
      incharge_mobile: "TEXT NOT NULL DEFAULT ''",
      incharge_email: "TEXT NOT NULL DEFAULT ''",
    });

    const roundOff = { round_off: 'REAL NOT NULL DEFAULT 0' };
    addCols('requisitions', roundOff);
    addCols('quotations', { ...roundOff, general_terms: "TEXT NOT NULL DEFAULT ''" });
    addCols('purchase_orders', {
      ...roundOff,
      general_terms: "TEXT NOT NULL DEFAULT ''",
      billing_address_source: "TEXT NOT NULL DEFAULT 'unit'",
      billing_unit_id: 'INTEGER',
      billing_address: "TEXT NOT NULL DEFAULT ''",
      shipping_location_type: "TEXT NOT NULL DEFAULT 'billing'",
      shipping_location_id: 'INTEGER',
      shipping_location_label: "TEXT NOT NULL DEFAULT ''",
      shipping_address: "TEXT NOT NULL DEFAULT ''",
      delivery_contact_name: "TEXT NOT NULL DEFAULT ''",
      delivery_contact_designation: "TEXT NOT NULL DEFAULT ''",
      delivery_contact_mobile: "TEXT NOT NULL DEFAULT ''",
      delivery_contact_email: "TEXT NOT NULL DEFAULT ''",
      additional_contacts: "TEXT NOT NULL DEFAULT '[]'",
    });
    addCols('grns', roundOff);
    addCols('invoices', roundOff);
    addCols('bills', roundOff);
    addCols('rfqs', { general_terms: "TEXT NOT NULL DEFAULT ''" });

    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.delivery_roundoff_terms.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Additive department codes, used in purchase-order numbering. */
  const migDeptCodes = db
    .prepare("SELECT value FROM settings WHERE key = 'migration.department_codes.v1'")
    .get();
  if (!migDeptCodes) {
    const deptColumns = new Set(db.prepare('PRAGMA table_info(departments)').all().map((r) => r.name));
    if (!deptColumns.has('code')) db.exec("ALTER TABLE departments ADD COLUMN code TEXT NOT NULL DEFAULT ''");

    const seedCodes = {
      1: 'ADMIN', 2: 'MAINT', 3: 'SEC', 4: 'TRANSPORT', 5: 'HOUSEKEEPING',
      6: 'IT', 7: 'HR', 8: 'FACILITY', 9: 'PURCHASE', 10: 'STORES',
      11: 'PRINTING', 12: 'MEDIA', 13: 'BUILDING', 14: 'MEP', 15: 'CIVIL',
      16: 'BOOKSTORE', 17: 'EVENTS', 18: 'ENGLISH', 19: 'TELUGU', 20: 'HINDI',
      21: 'FINANCE', 22: 'ACCOUNTS', 23: 'MUSIC', 24: 'CHILDREN', 25: 'OUTREACH',
      26: 'PASTORAL',
    };
    const used = new Set();
    const update = db.prepare('UPDATE departments SET code = ? WHERE id = ?');
    for (const dept of db.prepare('SELECT id, name FROM departments ORDER BY id').all()) {
      const fallback = String(dept.name || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 20) || `DEPT${dept.id}`;
      const base = seedCodes[dept.id] || fallback;
      let code = base;
      let suffix = 2;
      while (used.has(code)) code = `${base.slice(0, 17)}_${suffix++}`;
      used.add(code);
      update.run(code, dept.id);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_code ON departments(code) WHERE code <> ''");
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.department_codes.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Repair legacy purchase-order headers whose totals predate the shared
   * tax/discount/round-off calculation. Repeat-safe and audited: only rows
   * whose computed values changed are written, and the marker runs once.
   * Kept self-contained (no util/tax imports) because db.js calls this module
   * before its own exports are available. */
  const migPoTotals = db
    .prepare("SELECT value FROM settings WHERE key = 'migration.po_totals_repair.v1'")
    .get();
  if (!migPoTotals) {
    const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
    const orders = db
      .prepare(
        `SELECT id, subtotal, tax_amount, discount_amount, round_off, total_amount,
                freight_charges, loading_charges, other_charges,
                discount_percent
           FROM purchase_orders`
      )
      .all();
    const lineStmt = db.prepare(
      'SELECT taxable_amount, tax_amount, total_amount FROM po_items WHERE po_id = ?'
    );
    const updateStmt = db.prepare(
      `UPDATE purchase_orders
          SET subtotal = ?, tax_amount = ?, discount_amount = ?,
              round_off = ?, total_amount = ?
        WHERE id = ?`
    );
    const auditStmt = db.prepare(
      `INSERT INTO audit_logs(user_id, action, entity_type, entity_id, old_value, new_value, ip_address, created_at)
       VALUES (NULL, 'SYSTEM_RECALC', 'purchase_order', ?, ?, ?, NULL, ?)`
    );
    const stamp = new Date().toISOString();
    for (const order of orders) {
      const lines = lineStmt.all(order.id);
      if (!lines.length) continue;
      const subtotal = r2(lines.reduce((sum, line) => sum + Number(line.taxable_amount || 0), 0));
      const taxAmount = r2(lines.reduce((sum, line) => sum + Number(line.tax_amount || 0), 0));
      const gross = r2(lines.reduce((sum, line) => sum + Number(line.total_amount || 0), 0));
      const charges = r2(
        (Number(order.freight_charges) || 0)
        + (Number(order.loading_charges) || 0)
        + (Number(order.other_charges) || 0)
      );
      const flatDiscount = r2(Number(order.discount_amount) || 0);
      const percentDiscount = r2((gross * (Number(order.discount_percent) || 0)) / 100);
      const discountAmount = r2(Math.min(gross, percentDiscount + flatDiscount));
      const baseTotalAmount = r2(gross - discountAmount + charges);
      const totalAmount = Math.round(baseTotalAmount + Number.EPSILON);
      const newValues = {
        subtotal,
        taxAmount,
        discountAmount,
        roundOff: r2(totalAmount - baseTotalAmount),
        totalAmount,
      };
      const oldValues = {
        subtotal: r2(order.subtotal),
        taxAmount: r2(order.tax_amount),
        discountAmount: r2(order.discount_amount),
        roundOff: r2(order.round_off),
        totalAmount: r2(order.total_amount),
      };
      const changed = Object.keys(newValues).some(
        (key) => r2(newValues[key]) !== r2(oldValues[key])
      );
      if (!changed) continue;
      updateStmt.run(
        newValues.subtotal, newValues.taxAmount, newValues.discountAmount,
        newValues.roundOff, newValues.totalAmount, order.id
      );
      auditStmt.run(
        order.id, JSON.stringify(oldValues), JSON.stringify(newValues), stamp
      );
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.po_totals_repair.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Preserve the item name typed on a PO line. The old schema relied on the
   * item master name, so a custom name was lost on save and the print defaulted
   * back to the catalog name. Additive, repeat-safe and audited. */
  const migPoItemName = db
    .prepare("SELECT value FROM settings WHERE key = 'migration.po_item_name.v1'")
    .get();
  if (!migPoItemName) {
    const poItemCols = new Set(db.prepare('PRAGMA table_info(po_items)').all().map((r) => r.name));
    if (!poItemCols.has('item_name')) {
      db.exec('ALTER TABLE po_items ADD COLUMN item_name TEXT');
    }
    const stamp = new Date().toISOString();
    const missing = db
      .prepare(
        `SELECT pi.id, pi.description, i.name AS catalog_name
           FROM po_items pi LEFT JOIN items i ON i.id = pi.item_id
          WHERE (pi.item_name IS NULL OR TRIM(pi.item_name) = '')
            AND pi.description IS NOT NULL AND TRIM(pi.description) <> ''`
      )
      .all();
    const update = db.prepare('UPDATE po_items SET item_name = ?, updated_at = ? WHERE id = ?');
    const audit = db.prepare(
      `INSERT INTO audit_logs(user_id, action, entity_type, entity_id, old_value, new_value, ip_address, created_at)
       VALUES (NULL, 'SYSTEM_MIGRATION', 'purchase_order_item', ?, ?, ?, NULL, ?)`
    );
    for (const row of missing) {
      const savedName = String(row.description).trim().slice(0, 200);
      if (savedName === String(row.catalog_name || '').trim()) continue;
      update.run(savedName, stamp, row.id);
      audit.run(
        row.id,
        JSON.stringify({ itemName: null, description: row.description }),
        JSON.stringify({ itemName: savedName }),
        stamp
      );
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.po_item_name.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Persist the raw flat discount separately from the applied total. Forms
   * read this column directly, so a saved percentage discount can never be
   * mistaken for a flat amount on the next edit. Additive and repeat-safe. */
  const migFlatDiscount = db
    .prepare("SELECT value FROM settings WHERE key = 'migration.po_flat_discount.v1'")
    .get();
  if (!migFlatDiscount) {
    const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
    const hasColumn = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    const poItemCols = hasColumn('po_items');
    const poCols = hasColumn('purchase_orders');
    const grnCols = hasColumn('grns');
    if (!poItemCols.has('flat_discount_amount')) {
      db.exec('ALTER TABLE po_items ADD COLUMN flat_discount_amount REAL NOT NULL DEFAULT 0');
    }
    if (!poCols.has('flat_discount_amount')) {
      db.exec('ALTER TABLE purchase_orders ADD COLUMN flat_discount_amount REAL NOT NULL DEFAULT 0');
    }
    if (!grnCols.has('flat_discount_amount')) {
      db.exec('ALTER TABLE grns ADD COLUMN flat_discount_amount REAL NOT NULL DEFAULT 0');
    }
    const stamp = new Date().toISOString();
    const audit = db.prepare(
      `INSERT INTO audit_logs(user_id, action, entity_type, entity_id, old_value, new_value, ip_address, created_at)
       VALUES (NULL, 'SYSTEM_MIGRATION', ?, ?, ?, ?, NULL, ?)`
    );
    const lineRows = db
      .prepare(
        `SELECT id, quantity, unit_price, discount_percent, flat_discount_amount, discount_amount
           FROM po_items`
      )
      .all();
    const updateLine = db.prepare('UPDATE po_items SET flat_discount_amount = ? WHERE id = ?');
    for (const row of lineRows) {
      const gross = r2(r2(row.quantity) * r2(row.unit_price));
      const percentPart = r2((gross * r2(row.discount_percent)) / 100);
      const flat = Math.max(0, r2(r2(row.discount_amount) - percentPart));
      if (r2(row.flat_discount_amount) === flat) continue;
      updateLine.run(flat, row.id);
      audit.run(
        'purchase_order_item', row.id,
        JSON.stringify({ discountAmount: r2(row.discount_amount), discountPercent: r2(row.discount_percent) }),
        JSON.stringify({ flatDiscountAmount: flat, discountAmount: r2(row.discount_amount) }),
        stamp
      );
    }
    const headerRows = db
      .prepare(
        `SELECT p.id, p.discount_percent, p.flat_discount_amount, p.discount_amount,
                COALESCE(SUM(pi.total_amount), 0) AS gross
           FROM purchase_orders p
           LEFT JOIN po_items pi ON pi.po_id = p.id
          GROUP BY p.id`
      )
      .all();
    const updateHeader = db.prepare('UPDATE purchase_orders SET flat_discount_amount = ? WHERE id = ?');
    for (const row of headerRows) {
      const percentPart = r2((r2(row.gross) * r2(row.discount_percent)) / 100);
      const flat = Math.max(0, r2(r2(row.discount_amount) - percentPart));
      if (r2(row.flat_discount_amount) === flat) continue;
      updateHeader.run(flat, row.id);
      audit.run(
        'purchase_order', row.id,
        JSON.stringify({ discountAmount: r2(row.discount_amount), discountPercent: r2(row.discount_percent) }),
        JSON.stringify({ flatDiscountAmount: flat, discountAmount: r2(row.discount_amount) }),
        stamp
      );
    }
    const grnRows = db
      .prepare(
        `SELECT g.id, g.discount_percent, g.flat_discount_amount, g.discount_amount,
                COALESCE(SUM(gi.total_amount), 0) AS gross
           FROM grns g
           LEFT JOIN grn_items gi ON gi.grn_id = g.id
          GROUP BY g.id`
      )
      .all();
    const updateGrn = db.prepare('UPDATE grns SET flat_discount_amount = ? WHERE id = ?');
    for (const row of grnRows) {
      const percentPart = r2((r2(row.gross) * r2(row.discount_percent)) / 100);
      const flat = Math.max(0, r2(r2(row.discount_amount) - percentPart));
      if (r2(row.flat_discount_amount) === flat) continue;
      updateGrn.run(flat, row.id);
      audit.run(
        'goods_receipt', row.id,
        JSON.stringify({ discountAmount: r2(row.discount_amount), discountPercent: r2(row.discount_percent) }),
        JSON.stringify({ flatDiscountAmount: flat, discountAmount: r2(row.discount_amount) }),
        stamp
      );
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('migration.po_flat_discount.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  }

  /* Migration: manually entered reference on each purchase order. */
  const migPoReference = db.prepare("SELECT value FROM settings WHERE key = 'migration.po_reference.v1'").get();
  if (!migPoReference) {
    const poHeadCols = new Set(db.prepare('PRAGMA table_info(purchase_orders)').all().map((r) => r.name));
    if (!poHeadCols.has('reference')) {
      db.exec("ALTER TABLE purchase_orders ADD COLUMN reference TEXT NOT NULL DEFAULT ''");
    }
    db.prepare("INSERT INTO settings(key, value) VALUES ('migration.po_reference.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  }

  /* Migration: associate optional PO reference photos with a PO line item. */
  const migPoReferencePhotoItem = db.prepare("SELECT value FROM settings WHERE key = 'migration.po_reference_photo_item.v1'").get();
  if (!migPoReferencePhotoItem) {
    const photoCols = new Set(db.prepare('PRAGMA table_info(po_reference_photos)').all().map((r) => r.name));
    if (!photoCols.has('po_item_id')) {
      db.exec('ALTER TABLE po_reference_photos ADD COLUMN po_item_id INTEGER REFERENCES po_items(id) ON DELETE SET NULL');
    }
    db.prepare("INSERT INTO settings(key, value) VALUES ('migration.po_reference_photo_item.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  }

  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('migration.asset_components.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase5c.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('procurement.phase5e.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

module.exports = { ensureProcurementSchema };
