// One DB round-trip for headers, lines and payments. Never cache financial data.
export async function readPurchases(query, farmerId) {
  const { rows } = await query(`
    SELECT o.id, o.order_no ref_no, 'ORDER' kind, o.order_date date, o.status::text status,
      o.total_amount,
      COALESCE((SELECT SUM(i.amount_paid) FROM invoices i WHERE i.order_id=o.id), 0) amount_paid,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'productName', l.product_name, 'quantity', l.quantity, 'unitPrice', l.unit_price,
        'lineTotal', l.line_total, 'uom', l.uom, 'packingSize', l.packing_size) ORDER BY l.id)
        FROM order_lines l WHERE l.order_id=o.id), '[]'::jsonb) items
    FROM orders o WHERE o.farmer_id=$1
    UNION ALL
    SELECT s.id, s.sale_no ref_no, 'DIRECT' kind, s.sale_date date, NULL::text status,
      s.total_amount, s.amount_paid,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'productName', l.product_name, 'quantity', l.quantity, 'unitPrice', l.unit_price,
        'lineTotal', l.line_total, 'uom', p.uom, 'packingSize', COALESCE(l.packing_size, p.packing_size)) ORDER BY l.id)
        FROM party_sale_lines l LEFT JOIN products p ON p.id=l.product_id WHERE l.sale_id=s.id), '[]'::jsonb) items
    FROM party_sales s WHERE s.farmer_id=$1
    ORDER BY date DESC, id`, [farmerId]);
  return rows.map((r) => {
    const total = Number(r.total_amount) || 0, paid = Number(r.amount_paid) || 0;
    return {
      id: r.id, refNo: r.ref_no, kind: r.kind,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
      status: r.kind === 'DIRECT' ? (paid >= total ? 'PAID' : paid > 0 ? 'PARTIAL' : 'DUE') : r.status,
      totalAmount: total, amountPaid: paid, balanceDue: Math.round((total - paid) * 100) / 100,
      items: r.items ?? [],
    };
  });
}
