"use client";

export default function ReportsPage() {
  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Reports</h1>
          <div className="sub">Analytics and export summaries for your workspace.</div>
        </div>
      </div>

      <div className="reports-grid">
        <div className="report-card">
          <h3>Monthly Revenue</h3>
          <p>Revenue breakdown by month across all invoices.</p>
          <div className="report-placeholder">Chart coming soon</div>
        </div>
        <div className="report-card">
          <h3>Client Distribution</h3>
          <p>Invoice volume and value per client.</p>
          <div className="report-placeholder">Chart coming soon</div>
        </div>
        <div className="report-card">
          <h3>Inkoop vs Verkoop</h3>
          <p>Purchase vs sales invoice comparison.</p>
          <div className="report-placeholder">Chart coming soon</div>
        </div>
        <div className="report-card">
          <h3>Processing Status</h3>
          <p>File processing success rate and errors.</p>
          <div className="report-placeholder">Chart coming soon</div>
        </div>
      </div>
    </main>
  );
}
