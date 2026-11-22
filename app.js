async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Request failed");
  }
  return response.json();
}
function naira(value) {
  return "₦" + Math.round(Number(value) || 0).toLocaleString("en-NG");
}
function nav(active) {
  return `
    <aside class="sidebar">
      <div class="brand">GEME3T Admin</div>
      <nav class="nav">
        <a class="${active === "dashboard" ? "active" : ""}" href="/index.html">Dashboard</a>
        <a class="${active === "quotes" ? "active" : ""}" href="/quotes.html">New Sales</a>
        <a class="${active === "operations" ? "active" : ""}" href="/operations.html">Sales Reports</a>
        <a class="${active === "services" ? "active" : ""}" href="/services.html">Services</a>
        <a class="${active === "customers" ? "active" : ""}" href="/customers.html">Customers</a>
        <a class="${active === "coupons" ? "active" : ""}" href="/coupons.html">Coupons</a>
        <a class="${active === "affiliates" ? "active" : ""}" href="/affiliates.html">Affiliates</a>
        <a class="${active === "finance" ? "active" : ""}" href="/finance.html">Income & Expenses</a>
      </nav>
    </aside>`;
}
