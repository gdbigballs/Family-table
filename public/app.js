// ============================================================================
// 家宴点单 · 前端单页应用（public/app.js）
// 无框架、无构建步骤，由 index.html 直接引入。
// 分区结构见下方 ===== 注释；交互统一由“全局事件委托”分区的事件监听处理。
// 保持单文件以维持脚本执行顺序（const 定义与事件注册顺序），请勿拆分后打乱顺序。
// ============================================================================
const state = { site: null, menu: [], cart: JSON.parse(localStorage.getItem('family-table-cart') || '[]'), selected: null, adminTab: 'overview', orderFilter: 'pending', waitingRefreshTimer: null, editingDish: null, optionDrafts: [], reviewRating: 5, reviewsExpanded: false, reviewManagementDish: null };
const app = document.querySelector('#app');
state.heroQuote = null;
state.heroQuoteLoading = false;
const api = async (url, options = {}) => { const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data; };
// 下单幂等键：每次提交生成一次性编号，服务端对同一编号 15 分钟内只处理一次，防止双击 / 网络重试导致重复下单。
// 局域网 HTTP（非安全上下文）下 crypto.randomUUID 不可用，这里做兼容回退。
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `rid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
// 极简 Markdown 渲染：仅支持 release notes 常用语法（标题 / 列表 / 粗体 / 行内代码 / 代码块 / 链接 / 段落）。
// 先整体 HTML 转义再渲染标记，链接仅允许 http/https，防止 XSS 与 javascript: 注入。
function renderMarkdown(text) {
  const codeSpans = [];
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const inline = value => escape(value)
    .replace(/`([^`]+)`/g, (_, code) => { codeSpans.push(`<code>${code}</code>`); return `\u0000${codeSpans.length - 1}\u0000`; })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
  const lines = String(text || '').split(/\r?\n/);
  const html = []; let inCode = false; let codeBuffer = []; let list = null;
  const closeList = () => { if (list) { html.push(list === 'ul' ? '</ul>' : '</ol>'); list = null; } };
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) { html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`); codeBuffer = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuffer.push(escape(raw)); continue; }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeList(); const level = Math.min(6, heading[1].length + 2); html.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    if (/^\s*[-*]\s+/.test(raw)) { if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; } html.push(`<li>${inline(raw.replace(/^\s*[-*]\s+/, ''))}</li>`); continue; }
    if (/^\s*\d+\.\s+/.test(raw)) { if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; } html.push(`<li>${inline(raw.replace(/^\s*\d+\.\s+/, ''))}</li>`); continue; }
    if (!raw.trim()) { closeList(); continue; }
    closeList();
    html.push(`<p>${inline(raw)}</p>`);
  }
  closeList();
  if (inCode) html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
  return html.join('\n');
}
const escapeHtml = value => String(value || '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
const dateValue = offset => { const date = new Date(); date.setDate(date.getDate() + offset); return date.toISOString().slice(0, 10); };
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2400); }
function saveCart() { localStorage.setItem('family-table-cart', JSON.stringify(state.cart)); }
function cartCount() { return state.cart.reduce((sum, item) => sum + item.quantity, 0); }
function brand() { const logo = state.site.logoUrl ? `<img src="${escapeHtml(state.site.logoUrl)}" alt="">` : '🍲'; return `<a class="brand" href="#menu"><span class="brand-logo">${logo}</span><span>${escapeHtml(state.site.title)}</span></a>`; }
// ===== 布局 / 公共框架 / 路由 =====
function image(url) { return url ? escapeHtml(url) : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22600%22 height=%22440%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23e1ece2%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%232f513f%22 font-size=%2240%22%3E%3F%3C/text%3E%3C/svg%3E'; }
function adminLayout(content) { return `<header class="topbar admin-topbar"><div class="admin-brand">${brand()}<span>家庭管理</span></div><nav class="nav"><button class="text-button" data-route="menu">返回点菜</button></nav></header>${content}`; }
function appRoot(content) { app.innerHTML = layout(content) + publicFooter() + modal(); }
function selectedDish(id) { return state.menu.flatMap(category => category.dishes).find(dish => dish.id === Number(id)); }
async function loadSlots(form) { const date = form.elements.date.value; const select = form.elements.timeSlot; const hint = form.querySelector('#slot-hint'); select.innerHTML = '<option value="">读取可用时段...</option>'; try { const result = await api(`/api/availability?date=${date}`); if (!result.slots.length) { select.innerHTML = '<option value="">当天不可预约</option>'; hint.textContent = result.reason || ''; return; } select.innerHTML = '<option value="">请选择时段</option>' + result.slots.map(slot => `<option ${slot.available ? '' : 'disabled'} value="${slot.time}">${slot.time} ${slot.available ? `（剩余 ${slot.remainingGuests} 人）` : '（已满）'}</option>`).join(''); hint.textContent = '可预约时段会根据当前预约数量实时更新。'; } catch (error) { hint.textContent = error.message; } }
function renderAdmin() { api('/api/admin/me').then(() => adminPage()).catch(() => adminLogin()); }
// ===== 后台：框架与概览 =====

// 统一同步三处后台导航的高亮与 aria-selected：桌面横排 tabs、移动端底部 Tab 栏、更多抽屉
function syncAdminNav() {
  const tab = state.adminTab;
  const moreTabs = ['reviews', 'images', 'settings', 'menu-transfer', 'about'];
  document.querySelectorAll('.admin-tabs [data-admin-tab]').forEach(button => { button.classList.toggle('active', button.dataset.adminTab === tab); button.setAttribute('aria-selected', String(button.dataset.adminTab === tab)); });
  document.querySelectorAll('.admin-bottom-bar [data-admin-tab]').forEach(button => { button.classList.toggle('active', button.dataset.adminTab === tab); button.setAttribute('aria-selected', String(button.dataset.adminTab === tab)); });
  document.querySelectorAll('.admin-more-drawer [data-admin-tab]').forEach(button => { button.classList.toggle('active', button.dataset.adminTab === tab); button.setAttribute('aria-selected', String(button.dataset.adminTab === tab)); });
  const moreToggle = document.querySelector('.admin-more-toggle');
  if (moreToggle) { moreToggle.classList.toggle('active', moreTabs.includes(tab)); moreToggle.setAttribute('aria-selected', String(moreTabs.includes(tab))); }
}
// 局部刷新当前后台视图：不重建 admin-shell 框架，仅重新拉取并渲染 #admin-content，
// 避免操作后滚动位置/焦点丢失、弹窗被销毁、重复请求 dashboard。
async function refreshAdminContent() {
  const dashboard = await api('/api/admin/dashboard');
  await adminContent(dashboard);
  syncAdminNav();
}
function orderWorkCards(orders) { return orders.length ? orders.map(orderWorkCard).join('') : '<div class="empty">这个状态下暂时没有订单</div>'; }
function overviewOrderType(order) { return order.kind === 'immediate' ? '立即点菜' : order.kind === 'reservation' ? '仅预约' : '预约点单'; }
function overviewOrderSummary(order) { if (!order.items.length) return '未选择菜品'; const first = order.items[0]; return `${first.dish_name} x${first.quantity}${order.items.length > 1 ? ` 等 ${order.items.length} 道` : ''}`; }
function overviewOrderRow(order) { const action = overviewOrderNeedsAction(order) ? '<button type="button" class="secondary overview-order-action" data-admin-tab="orders">处理</button>' : '<span class="overview-order-action-placeholder" aria-hidden="true"></span>'; return `<article class="overview-order-row"><div class="overview-order-state"><span class="status ${order.status}">${order.status}</span><small>${overviewOrderType(order)}</small></div><div class="overview-order-code"><strong>${order.code}</strong><span>${order.guests} 人</span></div><div class="overview-order-schedule"><strong>${order.date} ${order.time_slot}</strong><span>用餐时间</span></div><div class="overview-order-summary" title="${escapeHtml(overviewOrderSummary(order))}"><strong>${escapeHtml(order.contact_name)}</strong><span>${escapeHtml(overviewOrderSummary(order))}</span></div>${action}</article>`; }
function orderCards(orders) { return orders.length ? `<section class="overview-order-list">${orders.map(overviewOrderRow).join('')}</section>` : '<div class="empty">目前没有订单</div>'; }

async function upload(file) { if (!file) return ''; if (file.size > 4 * 1024 * 1024) throw new Error('图片不能超过 4MB'); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = async () => { try { resolve((await api('/api/admin/upload', { method:'POST', body:JSON.stringify({ dataUrl: reader.result }) })).url); } catch (error) { reject(error); } }; reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file); }); }
// ===== 全局事件委托（点击 / 表单 / 输入） =====
document.addEventListener('click', async event => { const route = event.target.closest('[data-route]'); if (route) { location.hash = route.dataset.route; return; } const dishButton = event.target.closest('[data-dish]'); if (dishButton) { state.selected = selectedDish(dishButton.dataset.dish); state.reviewRating = 5; render(); loadDishReviews(state.selected.id); return; } if (event.target.matches('[data-action="close-dish"]') || event.target.closest('button[data-action="close-dish"]')) { state.selected = null; render(); return; } if (event.target.closest('[data-action="open-cart"]')) { app.insertAdjacentHTML('beforeend', cartDrawer()); return; } if (event.target.matches('[data-action="close-cart"]') || event.target.closest('button[data-action="close-cart"]')) { document.querySelector('.drawer-backdrop')?.remove(); return; } const remove = event.target.closest('[data-remove-cart]'); if (remove) { state.cart.splice(Number(remove.dataset.removeCart),1); saveCart(); refreshCartDrawer(); return; } const option = event.target.closest('[data-option]'); if (option) { const group = option.closest('.option-group'); if (group.dataset.type === 'single') group.querySelectorAll('.chip').forEach(chip => chip.classList.remove('selected')); option.classList.toggle('selected'); return; } const action = event.target.closest('[data-action]')?.dataset.action; if (action === 'plus' || action === 'minus') { const qty = document.querySelector('#dish-qty'); qty.textContent = Math.max(1, Number(qty.textContent) + (action === 'plus' ? 1 : -1)); return; } if (action === 'logout') { await api('/api/admin/logout',{method:'POST'}); toast('已退出后台'); render(); return; } if (action === 'cancel-edit') { state.editingDish = null; renderAdmin(); return; } if (action === 'toggle-admin-more') { const drawer = document.querySelector('.admin-more-drawer'); const open = drawer ? !drawer.classList.contains('is-open') : false; drawer?.classList.toggle('is-open', open); const backdrop = document.querySelector('.admin-more-backdrop'); if (backdrop) backdrop.hidden = !open; return; } if (action === 'close-admin-more') { document.querySelector('.admin-more-drawer')?.classList.remove('is-open'); event.target.hidden = true; return; } if (action === 'open-menu-category-picker') { document.querySelector('.menu-category-picker')?.classList.add('is-open'); const backdrop = document.querySelector('.menu-category-picker-backdrop'); if (backdrop) backdrop.hidden = false; return; } if (action === 'close-menu-category-picker') { document.querySelector('.menu-category-picker')?.classList.remove('is-open'); const backdrop = document.querySelector('.menu-category-picker-backdrop'); if (backdrop) backdrop.hidden = true; return; } if (action === 'open-menu-category-manager') { document.querySelector('.menu-category-picker')?.classList.remove('is-open'); const pickerBackdrop = document.querySelector('.menu-category-picker-backdrop'); if (pickerBackdrop) pickerBackdrop.hidden = true; document.querySelector('.menu-category-manager')?.classList.add('is-open'); const managerBackdrop = document.querySelector('.menu-category-manager-backdrop'); if (managerBackdrop) managerBackdrop.hidden = false; return; } if (action === 'close-menu-category-manager') { document.querySelector('.menu-category-manager')?.classList.remove('is-open'); const backdrop = document.querySelector('.menu-category-manager-backdrop'); if (backdrop) backdrop.hidden = true; return; } if (action === 'open-booking-rules') { state.adminTab = 'orders'; state.ordersView = 'rules'; refreshAdminContent(); return; } const tab = event.target.closest('[data-admin-tab]'); if (tab) { state.adminTab = tab.dataset.adminTab; document.querySelector('.admin-more-drawer')?.classList.remove('is-open'); const backdrop = document.querySelector('.admin-more-backdrop'); if (backdrop) backdrop.hidden = true; refreshAdminContent(); return; } const orderAction = event.target.closest('[data-order-action]'); if (orderAction) { const statusByAction = { confirm: '已确认', reject: '已拒绝', complete: '已完成', reopen: '待确认' }; const nextStatus = statusByAction[orderAction.dataset.orderAction]; if (orderAction.dataset.orderAction === 'reject' && !window.confirm('确定拒绝这条预约吗？拒绝后将释放该时段名额。')) return; await api(`/api/admin/orders/${orderAction.dataset.orderId}`, {method:'PUT',body:JSON.stringify({status:nextStatus})}); toast(`订单已${orderAction.textContent.trim()}`); refreshAdminContent(); return; } const scroll = event.target.closest('[data-scroll]'); if (scroll) document.querySelector(`#${scroll.dataset.scroll}`)?.scrollIntoView({behavior:'smooth'}); });
document.addEventListener('change', event => { if (event.target.matches('#booking-form [name="date"]')) loadSlots(event.target.closest('form')); });
document.addEventListener('submit', async event => { event.preventDefault(); const form = event.target; try { if (form.id === 'dish-form') { const dish = state.selected; const options = dish.options.map((group,index) => { const selected = [...form.querySelectorAll(`[data-group="${index}"] .chip.selected`)].map(el => el.dataset.value); if (group.required && !selected.length) throw new Error(`请选择${group.name}`); return selected.map(value => ({group:group.name,value})); }).flat(); state.cart.push({ name:dish.name, imageUrl:dish.imageUrl || '', quantity:Number(document.querySelector('#dish-qty').textContent), note:form.note.value.trim(), options }); saveCart(); state.selected=null; toast('已加入菜篮'); render(); return; } if (form.id === 'booking-form') { const error = form.querySelector('#booking-error'); error.classList.add('hidden'); if (!form.dataset.requestId) form.dataset.requestId = newRequestId(); const requestId = form.dataset.requestId; const fields = Object.fromEntries(new FormData(form)); const kind = form.dataset.kind; const result = await api(kind === 'order' ? '/api/order' : kind === 'immediate' ? '/api/immediate-order' : '/api/reservation', {method:'POST',body:JSON.stringify({...fields,guests:Number(fields.guests),items:state.cart,requestId})}); if (kind === 'order' || kind === 'immediate') { state.cart=[]; saveCart(); } form.dataset.requestId = ''; document.querySelector('#booking-result').innerHTML = `<div class="success booking-result"><strong>提交成功，等待管理员确认。</strong><p>订单编号：<b>${result.code}</b><br>查询凭证：<b>${result.token}</b></p><p class="hint">请妥善保存以上信息，用于之后查询订单或预约状态。</p><button class="secondary" data-route="lookup">去查询</button></div>`; form.classList.add('hidden'); showBookingSuccess(result); return; } if (form.id === 'lookup-form') { const error = form.querySelector('#lookup-error'); error.classList.add('hidden'); const fields = Object.fromEntries(new FormData(form)); const result = await api(`/api/lookup?code=${encodeURIComponent(fields.code)}&token=${encodeURIComponent(fields.token)}`); document.querySelector('#lookup-result').innerHTML = `<div class="panel lookup-result"><div class="section-heading"><div><h2>${result.code}</h2><p>${result.kind === 'reservation' ? '仅预约' : '点菜订单'} · 创建于 ${new Date(result.created_at).toLocaleString('zh-CN')}</p></div><span class="status ${result.status}">${result.status}</span></div><p><strong>${result.reservation.date} ${result.reservation.time_slot}</strong> · ${result.reservation.guests} 人</p>${result.items.length ? `<ul class="summary-list">${result.items.map(item=>`<li>${escapeHtml(item.dish_name)} × ${item.quantity}<br><span class="hint">${escapeHtml(item.options.map(x=>`${x.group}：${x.value}`).join('、'))}</span></li>`).join('')}</ul>` : '<p class="hint">这是一个仅预约记录，尚未选择菜品。</p>'}</div>`; return; } if (form.id === 'admin-login') { const error=form.querySelector('#admin-error'); error.classList.add('hidden'); const fields=Object.fromEntries(new FormData(form)); await api('/api/admin/login',{method:'POST',body:JSON.stringify(fields)}); toast('登录成功'); state.adminTab='overview'; adminPage(); return; } } catch(error) { const errorEl=form.querySelector('.error'); if(errorEl){errorEl.textContent=error.message;errorEl.classList.remove('hidden');}else toast(error.message); } });


// ===== 前台：菜品评价 =====
function reviewStars(rating) { return Array.from({ length: 5 }, (_, index) => index < Math.round(rating) ? '★' : '☆').join(''); }
function reviewMarkup(review) {
  const date = new Date(review.created_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return `<article class="review-item"><div class="review-meta"><strong>${escapeHtml(review.author)}</strong><span class="review-stars">${reviewStars(review.rating)}</span><time>${date}</time></div><p>${escapeHtml(review.content)}</p></article>`;
}
function renderReviewRating() {
  document.querySelectorAll('[data-review-rating]').forEach(button => button.classList.toggle('selected', Number(button.dataset.reviewRating) <= state.reviewRating));
}
function mountDishReviewDisclosure() {
  const section = document.querySelector('.dish-reviews');
  if (!section || section.dataset.disclosureMounted) return;
  section.dataset.disclosureMounted = 'true';

  const heading = section.querySelector('.dish-reviews-head h3');
  if (heading) heading.textContent = '评价';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dish-reviews-toggle';
  button.dataset.action = 'toggle-dish-reviews';
  button.setAttribute('aria-expanded', String(state.reviewsExpanded));
  button.textContent = state.reviewsExpanded ? '收起评价' : '查看评价';
  section.querySelector('.dish-reviews-head')?.append(button);

  const content = section.querySelector('#dish-reviews-content');
  const form = section.querySelector('#review-form');
  if (content) content.hidden = !state.reviewsExpanded;
  if (form) form.hidden = !state.reviewsExpanded;
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action="toggle-dish-reviews"]');
  if (!button) return;
  state.reviewsExpanded = !state.reviewsExpanded;
  const section = button.closest('.dish-reviews');
  const content = section?.querySelector('#dish-reviews-content');
  const form = section?.querySelector('#review-form');
  button.textContent = state.reviewsExpanded ? '收起评价' : '查看评价';
  button.setAttribute('aria-expanded', String(state.reviewsExpanded));
  if (content) content.hidden = !state.reviewsExpanded;
  if (form) form.hidden = !state.reviewsExpanded;
  if (state.reviewsExpanded && state.selected) loadDishReviews(state.selected.id);
});
document.addEventListener('click', event => {
  const star = event.target.closest('[data-review-rating]');
  if (!star) return;
  state.reviewRating = Number(star.dataset.reviewRating);
  renderReviewRating();
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'review-form') return;
  event.preventDefault();
  const error = form.querySelector('#review-error');
  error.classList.add('hidden');
  try {
    const fields = Object.fromEntries(new FormData(form));
    await api(`/api/dishes/${form.dataset.dishId}/reviews`, { method: 'POST', body: JSON.stringify({ author: fields.author, rating: state.reviewRating, content: fields.content }) });
    form.reset();
    state.reviewRating = 5;
    renderReviewRating();
    await loadDishReviews(Number(form.dataset.dishId));
    toast('点评已提交');
  } catch (failure) {
    error.textContent = failure.message;
    error.classList.remove('hidden');
  }
});

// ===== 后台：概览与关于项目 =====
function businessStatusBadge(site) {
  const open = site?.siteOpen;
  return `<section class="business-status-card ${open ? 'is-open' : 'is-closed'}"><div><span>营业状态</span><strong>${open ? '营业中' : '已暂停营业'}<i aria-hidden="true"></i></strong><p>${open ? '当前接受新的预约与点单。' : '当前不接受新的预约与点单，已有订单不受影响。'}</p></div><button type="button" class="secondary business-status-edit" data-action="open-booking-rules">调整预约与营业</button></section>`;
}
function aboutProjectView() {
  return `<section class="about-project"><div class="about-hero"><div class="about-intro"><p class="about-eyebrow">ABOUT PROJECT</p><h1>家宴点单</h1><p class="about-lead">为家庭聚餐准备的轻量点单与预约工具。</p><div class="about-project-copy"><p>家宴点单让家人或朋友在到家前先选好菜、预约用餐时间；厨房则可以在一个后台中集中查看订单、维护菜单和配置接单规则。</p><p>项目专注于小范围、低维护的日常使用，不引入复杂的支付、会员或库存流程，保持部署和维护都足够轻量。</p></div><div class="about-value-grid"><article class="about-value"><span class="about-value-mark" aria-hidden="true">轻</span><div><h2>轻量高效</h2><p>聚焦点单、预约与后台管理，流程简单，便于日常维护。</p></div></article><article class="about-value"><span class="about-value-mark" aria-hidden="true">稳</span><div><h2>隐私友好</h2><p>不引入支付与会员体系，减少不必要的数据收集。</p></div></article><article class="about-value"><span class="about-value-mark" aria-hidden="true">新</span><div><h2>持续迭代</h2><p>围绕实际使用反馈，逐步补充实用的管理能力。</p></div></article></div></div><aside class="about-version-panel" aria-label="项目版本"><span class="about-version-kicker">FAMILY TABLE</span><div class="about-version-mark"><img src="/assets/family-table-logo.png" alt="家宴点单 Logo"></div><strong>家宴点单</strong><button type="button" class="about-version-link" data-action="open-changelog" title="查看更新日志"><b id="about-current-version">—</b></button><span>点击查看更新日志</span></aside></div><section class="about-resources"><header><h2>相关资源与支持</h2><p>查看项目来源、版本状态及推荐的开发者服务。</p></header><div class="about-resource-grid"><article class="about-resource-card"><div class="about-resource-mark about-resource-github"><img src="/assets/github.png" alt="GitHub 图标"></div><div><h3>GitHub 主页</h3><p>查看我的公开项目与后续项目地址。</p></div><a class="secondary" href="https://github.com/gdbigballs" target="_blank" rel="noreferrer">访问 GitHub</a></article><article class="about-resource-card"><div class="about-resource-mark about-resource-update" aria-hidden="true">UP</div><div><h3>检查更新</h3><p>检查是否有新版本发布和功能改进。</p></div><button class="secondary" type="button" data-action="check-update">检查更新</button></article><article class="about-resource-card"><div class="about-resource-mark about-resource-api"><img src="https://apikey.fun/logo.png" alt="apikey.fun Logo"></div><div><h3>API 站推荐</h3><p>推荐关注 apikey.fun，按需了解 API 服务与开发工具。</p></div><a class="secondary" href="https://apikey.fun/register?aff=DB9P9U2SUL3E" target="_blank" rel="noreferrer">访问 apikey.fun</a></article></div></section></section>`;
}
async function loadUpdateInfo() {
  const versionEl = document.querySelector('#about-current-version');
  if (!versionEl) return;
  try {
    const data = await api('/api/update/check');
    versionEl.textContent = `v${data.current}`;
  } catch { /* 拉取失败时保持占位，用户可点击按钮重试 */ }
}
async function checkUpdateNow() {
  const button = document.querySelector('[data-action="check-update"]');
  if (!button || button.disabled) return;
  button.disabled = true; button.textContent = '检查中...';
  try {
    const data = await api('/api/update/check');
    const versionEl = document.querySelector('#about-current-version');
    if (versionEl) versionEl.textContent = `v${data.current}`;
    if (data.error) { toast(data.error); return; }
    if (data.hasUpdate) { app.insertAdjacentHTML('beforeend', updateModal(data)); return; }
    toast(data.latest ? `当前已是最新版本 v${data.current}` : '当前暂无新版本发布');
  } catch (error) {
    toast(error.message || '暂时无法检查更新，请稍后再试');
  } finally {
    button.disabled = false; button.textContent = '检查更新';
  }
}
function updateModal(data) {
  const date = data.publishedAt ? `，发布于 ${new Date(data.publishedAt).toLocaleDateString('zh-CN')}` : '';
  const notes = data.notes ? `<div class="update-notes"><strong>本次更新内容</strong><div class="md">${renderMarkdown(data.notes)}</div></div>` : '';
  return `<div class="modal-backdrop" data-action="close-update-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="update-modal-title"><div class="modal-head"><h2 id="update-modal-title">发现新版本 v${data.latest}</h2><button class="close" type="button" data-action="close-update-modal" aria-label="关闭">×</button></div><div class="modal-content"><p class="hint">当前版本 v${data.current}${date}，可在 GitHub 查看发布说明并获取更新。</p>${notes}<div class="form-actions"><button class="secondary" type="button" data-action="close-update-modal">稍后再说</button><a class="primary" href="${data.url || 'https://github.com/gdbigballs/Family-table'}" target="_blank" rel="noreferrer">前往查看</a></div></div></section></div>`;
}
function changelogModal(data) {
  const items = data.items || [];
  const list = items.length ? items.map(item => `<article class="changelog-item"><header class="changelog-item-head"><strong>v${escapeHtml(item.tag)}</strong>${item.publishedAt ? `<span>${new Date(item.publishedAt).toLocaleDateString('zh-CN')}</span>` : ''}</header>${item.notes ? `<div class="md">${renderMarkdown(item.notes)}</div>` : '<p class="hint">该版本暂无详细说明。</p>'}${item.url ? `<a class="changelog-item-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">在 GitHub 查看 →</a>` : ''}</article>`).join('') : '<div class="empty">暂无更新日志</div>';
  return `<div class="modal-backdrop" data-action="close-changelog-modal"><section class="modal changelog-modal" role="dialog" aria-modal="true" aria-labelledby="changelog-modal-title"><div class="modal-head"><h2 id="changelog-modal-title">更新日志</h2><button class="close" type="button" data-action="close-changelog-modal" aria-label="关闭">×</button></div><div class="modal-content">${data.error ? `<p class="hint">${escapeHtml(data.error)}</p>` : `<div class="changelog-list">${list}</div>`}<div class="form-actions"><button class="secondary" type="button" data-action="close-changelog-modal">关闭</button></div></div></section></div>`;
}
async function openChangelog() {
  try {
    const data = await api('/api/update/changelog');
    app.insertAdjacentHTML('beforeend', changelogModal(data));
  } catch (error) {
    toast(error.message || '暂时无法加载更新日志');
  }
}
state.orderAdminFilters = state.orderAdminFilters || { query: '', status: 'all', page: 1, pageSize: 20 };
// ===== 后台：订单管理 =====
const orderAdminPageSizes = [10, 20, 30, 50, 100];
function orderAdminType(order) {
  return order.kind === 'immediate' ? '立即点菜' : order.kind === 'reservation' ? '仅预约' : '预约点单';
}
function orderAdminItems(order) {
  if (!order.items.length) return '仅预约时间，尚未选择菜品';
  const summary = order.items.slice(0, 2).map(item => `${item.dish_name} x${item.quantity}`).join('、');
  return `${summary}${order.items.length > 2 ? ` 等 ${order.items.length} 道` : ''}`;
}
function orderAdminPaginationMarkup(total, page, totalPages, pageSize) {
  const pageOptions = Array.from({ length: totalPages }, (_, index) => `<option value="${index + 1}" ${page === index + 1 ? 'selected' : ''}>${index + 1} / ${totalPages}</option>`).join('');
  const pageSizeOptions = orderAdminPageSizes.map(size => `<option value="${size}" ${pageSize === size ? 'selected' : ''}>${size}</option>`).join('');
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  return `<footer class="order-admin-footer"><span>显示 ${start}-${end}，共 ${total} 条订单</span><div class="order-admin-pagination"><button type="button" data-order-page-direction="prev" ${page <= 1 ? 'disabled' : ''} aria-label="上一页">&#8249;</button><button type="button" data-order-page-direction="next" ${page >= totalPages ? 'disabled' : ''} aria-label="下一页">&#8250;</button><select data-order-page aria-label="当前页">${pageOptions}</select><span>页</span><select data-order-page-size aria-label="每页条数">${pageSizeOptions}</select><span>条/页</span></div></footer>`;
}
function renderOrderAdminTable(orders) {
  const filters = state.orderAdminFilters;
  const query = filters.query.trim().toLowerCase();
  const filtered = orders.filter(order => (filters.status === 'all' || order.status === filters.status) && (!query || `${order.code} ${order.contact_name} ${order.contact_info} ${order.items.map(item => item.dish_name).join(' ')}`.toLowerCase().includes(query)));
  const pageSize = orderAdminPageSizes.includes(Number(filters.pageSize)) ? Number(filters.pageSize) : 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  filters.page = page;
  filters.pageSize = pageSize;
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map(order => {
    const actions = orderQuickActions(order);
    return `<tr><td><div class="order-admin-cell"><span class="status ${order.status}">${order.status}</span><small>${orderAdminType(order)}</small></div></td><td data-label="订单编号"><div class="order-admin-cell"><strong>${order.code}</strong><span>${order.guests} 人</span></div></td><td data-label="用餐时间"><div class="order-admin-cell"><strong>${order.date} ${order.time_slot}</strong><span>下单 ${orderCreatedAtLabel(order.created_at)}</span></div></td><td data-label="菜品内容" title="${escapeHtml(orderAdminItems(order))}">${escapeHtml(orderAdminItems(order))}</td><td data-label="联系人"><div class="order-admin-cell"><strong>${escapeHtml(order.contact_name)}</strong><a href="tel:${escapeHtml(order.contact_info)}">${escapeHtml(order.contact_info)}</a></div></td><td><div class="order-admin-actions">${actions}</div></td></tr>`;
  }).join('');
  return `<div class="order-admin-table-wrap"><table class="order-admin-table"><thead><tr><th>订单状态</th><th>订单编号</th><th>用餐 / 下单时间</th><th>菜品内容</th><th>联系人</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="order-admin-empty">没有符合当前筛选条件的订单。</td></tr>'}</tbody></table></div>${orderAdminPaginationMarkup(filtered.length, page, totalPages, pageSize)}`;
}
function rerenderOrderAdminTable() {
  const target = document.querySelector('#order-admin-table');
  if (target && state.orderAdminData) target.innerHTML = renderOrderAdminTable(state.orderAdminData);
}
document.addEventListener('input', event => {
  if (!event.target.matches('[data-order-admin-search]')) return;
  state.orderAdminFilters.query = event.target.value;
  state.orderAdminFilters.page = 1;
  rerenderOrderAdminTable();
  const search = document.querySelector('[data-order-admin-search]');
  if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-order-admin-status]')) {
    state.orderAdminFilters.status = event.target.value;
    state.orderAdminFilters.page = 1;
    rerenderOrderAdminTable();
    return;
  }
  if (event.target.matches('[data-order-page-size]')) {
    state.orderAdminFilters.pageSize = Number(event.target.value);
    state.orderAdminFilters.page = 1;
    rerenderOrderAdminTable();
    return;
  }
  if (event.target.matches('[data-order-page]')) {
    state.orderAdminFilters.page = Number(event.target.value);
    rerenderOrderAdminTable();
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-order-page-direction]');
  if (!button || button.disabled) return;
  state.orderAdminFilters.page += button.dataset.orderPageDirection === 'next' ? 1 : -1;
  rerenderOrderAdminTable();
});
document.addEventListener('click', async event => {
  const view = event.target.closest('[data-orders-view]');
  if (view) { state.ordersView = view.dataset.ordersView; await renderOrderAdminContent(document.querySelector('#admin-content')); return; }
  if (event.target.closest('[data-action="check-update"]')) { checkUpdateNow(); return; }
  if (event.target.closest('[data-action="open-changelog"]')) { openChangelog(); return; }
  if (event.target.closest('[data-action="close-update-modal"], [data-action="close-changelog-modal"]')) { document.querySelector('.modal-backdrop')?.remove(); return; }
});
// ===== 后台：站点设置 =====
function syncSitePresentation(site = state.site) {
  if (!site) return;
  document.title = site.title || '家宴点单';
  let favicon = document.querySelector('#site-favicon');
  if (!favicon) {
    favicon = document.createElement('link');
    favicon.id = 'site-favicon';
    favicon.rel = 'icon';
    document.head.append(favicon);
  }
  favicon.href = site.faviconUrl || '';
}
function settingsTabs(active) {
  const tabs = [
    ['basic', '基本设置'],
    ['access', '密码设置'],
    ['notifications', '通知设置']
  ];
  return `<nav class="settings-tabs" aria-label="站点设置页面">${tabs.map(([key, label]) => `<button type="button" class="${key === active ? 'active' : ''}" data-settings-page="${key}">${label}</button>`).join('')}</nav>`;
}
function settingsImageField(name, label, value, helper) {
  const preview = value ? `<img src="${escapeHtml(value)}" alt="${label}预览">` : '<span>未设置</span>';
  return `<div class="field full"><label>${label}</label><div class="settings-image-field"><div class="settings-image-preview">${preview}</div><div class="settings-image-controls"><input name="${name}" value="${escapeHtml(value)}" placeholder="可粘贴图片地址，或从附件中选择"><div><button class="secondary" type="button" data-settings-open-image-picker="${name}">选择图片</button><label class="image-upload-button">上传图片<input type="file" accept="image/png,image/jpeg,image/webp" data-settings-upload-image="${name}"></label><button class="danger" type="button" data-settings-clear-image="${name}">清除图片</button></div>${helper ? `<p class="hint">${helper}</p>` : ''}</div></div></div>`;
}
function settingsPanelHeader(title, description) {
  return `<header class="settings-panel-header"><h3>${title}</h3><span>${description}</span></header>`;
}
function basicSettingsView(data) {
  return `<section class="settings-panel">${settingsPanelHeader('基础设置', '配置公开站点的名称、欢迎文案和浏览器图标资源。')}<form id="site-basic-form"><div class="form-grid"><div class="field full"><label>站点标题</label><input name="title" value="${escapeHtml(data.title)}" maxlength="80" required></div><div class="field full"><label>欢迎语</label><textarea name="welcome" maxlength="300" placeholder="例如：提前选好菜，到家就能开饭。">${escapeHtml(data.welcome)}</textarea></div>${settingsImageField('logoUrl', 'Logo', data.logoUrl, '推荐使用正方形或横向的 PNG、JPG、WebP 图片。')}${settingsImageField('faviconUrl', 'Favicon', data.faviconUrl, '浏览器标签页的小图标，推荐上传清晰的正方形图片。')}</div><p class="error hidden"></p><div class="form-actions"><button class="primary">保存基本设置</button></div></form></section>`;
}
function passwordSettingsView() {
  return `<section class="settings-panel settings-panel-narrow">${settingsPanelHeader('访问控制', '更新管理员登录密码；新的登录会话将使用更新后的凭据验证。')}<form id="password-form"><div class="form-grid"><div class="field full"><label>当前密码</label><input name="currentPassword" type="password" required autocomplete="current-password"></div><div class="field full"><label>新密码</label><input name="newPassword" type="password" required autocomplete="new-password"></div></div><p class="error hidden" id="password-error"></p><div class="form-actions"><button class="primary">更新后台密码</button></div></form></section>`;
}
function notificationSettingsView(data) {
  const configured = data.wecomWebhookConfigured === true;
  const status = configured ? '<p class="success">已配置 Webhook，地址不会在后台回显。</p>' : '<p class="note-box">尚未配置 Webhook。保存后，新订单会自动推送到企业微信。</p>';
  const actions = configured ? '<button class="secondary" type="button" data-action="test-wecom-webhook">发送测试消息</button><button class="danger" type="button" data-action="clear-wecom-webhook">移除 Webhook</button>' : '';
  return `<section class="settings-panel settings-panel-narrow">${settingsPanelHeader('企业微信通知', '新订单写入成功后，会向企业微信机器人推送下单信息。')}${status}<form id="wecom-webhook-form"><div class="field full"><label>企业微信机器人 Webhook 地址</label><input name="wecomWebhookUrl" type="url" inputmode="url" maxlength="1000" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."><p class="hint">在企业微信群机器人设置中复制地址。留空不会改变当前配置。</p></div><p class="error hidden"></p><div class="form-actions"><button class="primary">保存通知设置</button>${actions}</div></form></section>`;
}
function bookingSettingsView(data) {
  const schedule = data.schedule || {};
  const days = Array.isArray(schedule.days) ? schedule.days : [];
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `<section class="settings-panel">${settingsPanelHeader('预约与营业', '配置接单状态、可预约时段和每时段容量限制。')}<form id="booking-settings-form"><section class="settings-block"><div class="settings-block-head"><div><strong>营业状态</strong><p>暂停后，访客不能提交新的预约或点单，已有记录不会受影响。</p></div><label class="settings-switch"><input name="siteOpen" type="checkbox" ${data.siteOpen ? 'checked' : ''}><span></span><b>${data.siteOpen ? '营业中' : '已暂停'}</b></label></div></section><section class="settings-block"><div class="settings-block-head"><div><strong>开放日期与时段</strong><p>只有勾选的日期和填写的时段会出现在预约页面。</p></div></div><div class="weekday-picker">${labels.map((label, value) => `<label><input type="checkbox" name="bookingDay" value="${value}" ${days.includes(value) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div><div class="field"><label>可预约时段</label><input name="slots" value="${escapeHtml((schedule.slots || []).join(', '))}" required placeholder="例如：11:30, 17:30"><p class="hint">多个时段用英文逗号隔开，使用 24 小时格式。</p></div></section><section class="settings-block"><div class="settings-block-head"><div><strong>容量与提前量</strong><p>同一时段会同时受人数和订单数限制。</p></div></div><div class="form-grid"><div class="field"><label>每时段最多人数</label><input name="maxPeople" type="number" min="1" max="100" value="${Number(schedule.maxPeople) || 8}" required></div><div class="field"><label>每时段最多订单数</label><input name="maxOrders" type="number" min="1" max="100" value="${Number(schedule.maxOrders) || 4}" required></div><div class="field"><label>最少提前小时数</label><input name="minLeadHours" type="number" min="0" max="168" value="${Number(schedule.minLeadHours) || 0}" required></div><div class="field"><label>最多可提前预约天数</label><input name="maxDays" type="number" min="1" max="365" value="${Number(schedule.maxDays) || 30}" required></div></div></section><p class="error hidden"></p><div class="form-actions"><button class="primary">保存预约规则</button></div></form></section>`;
}
async function renderSettings(el) {
  const data = await api('/api/admin/settings');
  const page = ['basic', 'access', 'notifications'].includes(state.settingsPage) ? state.settingsPage : 'basic';
  const views = { basic: basicSettingsView, access: passwordSettingsView, notifications: notificationSettingsView };
  el.innerHTML = `<section class="settings-workspace"><div class="order-workspace-head"><div><h2>站点设置</h2><p>集中配置站点展示信息与管理员访问控制。</p></div></div>${settingsTabs(page)}<div class="settings-content">${views[page](data)}</div></section>`;
}
adminSettings = renderSettings;
function settingsImagePickerModal(images, fieldName, currentUrl) {
  const cards = images.length ? images.map(file => `<article class="menu-image-picker-card ${file.url === currentUrl ? 'is-selected' : ''}"><button type="button" data-settings-image-select="${file.url}" title="选择 ${escapeHtml(file.name)}"><img src="${file.url}" alt="${escapeHtml(file.name)}"><span>${escapeHtml(file.name)}</span></button><div><small>${imageFileSize(file.size)}</small><button class="menu-icon-button is-danger" type="button" ${file.inUse ? 'disabled title="图片正在使用中"' : `data-settings-image-delete="${escapeHtml(file.name)}" title="删除图片"`} aria-label="删除图片">×</button></div></article>`).join('') : '<div class="menu-image-picker-empty">还没有上传图片</div>';
  return `<div class="modal-backdrop menu-image-picker-backdrop" data-settings-picker-field="${fieldName}"><section class="modal menu-image-picker-modal" role="dialog" aria-modal="true"><div class="modal-head"><div><h2>选择图片</h2><p class="hint">选择后会自动填入当前图片设置。</p></div><button class="close" type="button" data-action="close-settings-image-picker" aria-label="关闭">×</button></div><div class="modal-content"><div class="menu-image-picker-tools"><label class="image-upload-button"><input id="settings-image-picker-upload" type="file" accept="image/png,image/jpeg,image/webp">上传图片</label><span>支持 PNG、JPG、WebP，最大 4MB</span></div><div class="menu-image-picker-grid">${cards}</div></div></section></div>`;
}
async function openSettingsImagePicker(fieldName) {
  const currentUrl = document.querySelector(`#site-basic-form [name="${fieldName}"]`)?.value || '';
  const images = await api('/api/admin/images');
  document.querySelector('.menu-image-picker-backdrop')?.remove();
  app.insertAdjacentHTML('beforeend', settingsImagePickerModal(images, fieldName, currentUrl));
}
document.addEventListener('click', async event => {
  const tab = event.target.closest('[data-settings-page]');
  const open = event.target.closest('[data-settings-open-image-picker]');
  const clear = event.target.closest('[data-settings-clear-image]');
  const select = event.target.closest('[data-settings-image-select]');
  const remove = event.target.closest('[data-settings-image-delete]');
  const close = event.target.closest('[data-action="close-settings-image-picker"]');
  if (!tab && !open && !clear && !select && !remove && !close) return;
  try {
    if (tab) { state.settingsPage = tab.dataset.settingsPage; await renderSettings(document.querySelector('#admin-content')); return; }
    if (close) { document.querySelector('.menu-image-picker-backdrop')?.remove(); return; }
    if (open) { await openSettingsImagePicker(open.dataset.settingsOpenImagePicker); return; }
    if (clear) {
      const input = document.querySelector(`#site-basic-form [name="${clear.dataset.settingsClearImage}"]`);
      if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
      toast('图片已清除，保存后生效');
      return;
    }
    const backdrop = document.querySelector('.menu-image-picker-backdrop');
    const fieldName = backdrop?.dataset.settingsPickerField;
    if (select && fieldName) {
      const input = document.querySelector(`#site-basic-form [name="${fieldName}"]`);
      if (input) { input.value = select.dataset.settingsImageSelect; input.dispatchEvent(new Event('input', { bubbles: true })); }
      backdrop.remove();
      return;
    }
    if (remove) {
      if (!window.confirm('确定删除这张未使用的图片吗？')) return;
      await api(`/api/admin/images/${encodeURIComponent(remove.dataset.settingsImageDelete)}`, { method: 'DELETE' });
      toast('图片已删除');
      await openSettingsImagePicker(fieldName);
    }
  } catch (error) { toast(error.message || '图片操作失败'); }
});
document.addEventListener('input', event => {
  const input = event.target.closest('#site-basic-form [name="logoUrl"], #site-basic-form [name="faviconUrl"]');
  if (!input) return;
  const preview = input.closest('.settings-image-controls').previousElementSibling;
  preview.innerHTML = input.value ? `<img src="${escapeHtml(input.value)}" alt="图片预览">` : '<span>未设置</span>';
});
document.addEventListener('change', async event => {
  const uploadField = event.target.dataset.settingsUploadImage;
  if (!uploadField) return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const url = await upload(file);
    const input = document.querySelector(`#site-basic-form [name="${uploadField}"]`);
    if (input) { input.value = url; input.dispatchEvent(new Event('input', { bubbles: true })); }
    toast('图片已上传');
  } catch (error) { toast(error.message || '图片上传失败'); }
});
document.addEventListener('change', async event => {
  if (event.target.id !== 'settings-image-picker-upload') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await upload(file);
    toast('图片已上传');
    await openSettingsImagePicker(document.querySelector('.menu-image-picker-backdrop')?.dataset.settingsPickerField);
  } catch (error) { toast(error.message || '图片上传失败'); }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['site-basic-form', 'booking-settings-form', 'wecom-webhook-form'].includes(form.id)) return;
  event.preventDefault();
  const error = form.querySelector('.error');
  error.classList.add('hidden');
  try {
    const fields = Object.fromEntries(new FormData(form));
    let body;
    if (form.id === 'site-basic-form') body = { title: fields.title, welcome: fields.welcome, logoUrl: fields.logoUrl, faviconUrl: fields.faviconUrl };
    if (form.id === 'booking-settings-form') {
      const days = [...form.querySelectorAll('[name="bookingDay"]:checked')].map(input => Number(input.value));
      const slots = String(fields.slots || '').split(',').map(value => value.trim()).filter(Boolean);
      body = { siteOpen: form.elements.siteOpen.checked, schedule: { days, slots, maxPeople: Number(fields.maxPeople), maxOrders: Number(fields.maxOrders), minLeadHours: Number(fields.minLeadHours), maxDays: Number(fields.maxDays) } };
    }
    if (form.id === 'wecom-webhook-form') body = { wecomWebhookUrl: fields.wecomWebhookUrl };
    state.site = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
    syncSitePresentation();
    toast(form.id === 'booking-settings-form' ? '预约与营业规则已保存' : form.id === 'wecom-webhook-form' ? '通知设置已保存' : '基本设置已保存');
    if (form.id === 'booking-settings-form') await renderOrderAdminContent(document.querySelector('#admin-content'));
    else await renderSettings(document.querySelector('#admin-content'));
  } catch (failure) { error.textContent = failure.message; error.classList.remove('hidden'); }
});
document.addEventListener('click', async event => {
  const test = event.target.closest('[data-action="test-wecom-webhook"]');
  const clear = event.target.closest('[data-action="clear-wecom-webhook"]');
  if (!test && !clear) return;
  try {
    if (test) {
      test.disabled = true;
      test.textContent = '正在发送...';
      await api('/api/admin/wecom-webhook/test', { method: 'POST' });
      toast('测试消息已发送到企业微信');
      test.disabled = false;
      test.textContent = '发送测试消息';
      return;
    }
    if (!window.confirm('确定移除企业微信 Webhook 吗？之后新订单将不再推送。')) return;
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ clearWecomWebhook: true }) });
    toast('企业微信 Webhook 已移除');
    await renderSettings(document.querySelector('#admin-content'));
  } catch (failure) {
    if (test) { test.disabled = false; test.textContent = '发送测试消息'; }
    toast(failure.message || '操作失败');
  }
});
boot = async function() {
  try {
    [state.site, state.menu] = await Promise.all([api('/api/site'), api('/api/menu')]);
    syncSitePresentation();
    render();
  } catch (error) {
    app.innerHTML = `<main class="page"><div class="empty">无法加载服务：${escapeHtml(error.message)}</div></main>`;
  }
};
// ===== 后台：菜单管理 =====
function rerenderMenuAdminFilters() {
  const target = document.querySelector('#admin-content');
  if (target && state.menuAdminData) target.innerHTML = renderMenuAdminTable(state.menuAdminData);
}
document.addEventListener('input', event => {
  if (!event.target.matches('[data-menu-search]')) return;
  state.menuAdminFilters.query = event.target.value;
  state.menuAdminPagination.page = 1;
  rerenderMenuAdminFilters();
  const search = document.querySelector('[data-menu-search]');
  if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
});
document.addEventListener('change', event => {
  if (!event.target.matches('[data-menu-status-filter]')) return;
  state.menuAdminFilters.status = event.target.value;
  state.menuAdminPagination.page = 1;
  rerenderMenuAdminFilters();
});
document.addEventListener('click', event => {
  const category = event.target.closest('[data-menu-category-filter]');
  if (!category) return;
  state.menuAdminFilters.categoryId = category.dataset.menuCategoryFilter;
  state.menuAdminPagination.page = 1;
  rerenderMenuAdminFilters();
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-menu-page-size]')) {
    state.menuAdminPagination.pageSize = Number(event.target.value);
    state.menuAdminPagination.page = 1;
    rerenderMenuAdminFilters();
    return;
  }
  if (event.target.matches('[data-menu-page]')) {
    state.menuAdminPagination.page = Number(event.target.value);
    rerenderMenuAdminFilters();
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-menu-page-direction]');
  if (!button || button.disabled) return;
  state.menuAdminPagination.page += button.dataset.menuPageDirection === 'next' ? 1 : -1;
  rerenderMenuAdminFilters();
});
function menuOptionEditorMarkup() {
  const groups = state.menuOptionDrafts || [];
  if (!groups.length) return '<div class="menu-option-empty">还没有设置属性，可添加辣度、分量或忌口。</div>';
  return groups.map((group, groupIndex) => {
    const editing = state.menuEditingOptionIndex === groupIndex;
    const summary = `${group.type === 'multiple' ? '多选' : '单选'} · ${group.required ? '必选' : '可选'} · ${(group.values || []).filter(Boolean).length} 个选项`;
    const fields = editing ? `<div class="menu-option-edit-fields"><div class="form-grid"><div class="field"><label>属性名称</label><input data-menu-option-field="name" data-group-index="${groupIndex}" value="${escapeHtml(group.name)}" placeholder="例如：辣度"></div><div class="field"><label>选择方式</label><select data-menu-option-field="type" data-group-index="${groupIndex}"><option value="single" ${group.type === 'single' ? 'selected' : ''}>单选</option><option value="multiple" ${group.type === 'multiple' ? 'selected' : ''}>多选</option></select></div></div><label class="menu-option-required"><input type="checkbox" data-menu-option-field="required" data-group-index="${groupIndex}" ${group.required ? 'checked' : ''}> 顾客必须选择此属性</label><div class="menu-option-values"><span>可选内容</span>${(group.values || []).map((value, valueIndex) => `<div><input data-menu-option-field="value" data-group-index="${groupIndex}" data-value-index="${valueIndex}" value="${escapeHtml(value)}" placeholder="例如：微辣"><button class="menu-icon-button is-danger" type="button" data-menu-option-action="remove-value" data-group-index="${groupIndex}" data-value-index="${valueIndex}" title="删除选项" aria-label="删除选项">×</button></div>`).join('')}<button class="secondary" type="button" data-menu-option-action="add-value" data-group-index="${groupIndex}">+ 添加选项</button></div><div class="menu-option-edit-actions"><button class="secondary" type="button" data-menu-option-action="done" data-group-index="${groupIndex}">完成编辑</button></div></div>` : '';
    return `<article class="menu-option-card ${editing ? 'is-editing' : ''}"><div class="menu-option-card-head"><div><strong>${escapeHtml(group.name || '未命名属性')}</strong><span>${summary}</span></div><div><button class="secondary" type="button" data-menu-option-action="edit" data-group-index="${groupIndex}">${editing ? '编辑中' : '编辑'}</button><button class="menu-icon-button is-danger" type="button" data-menu-option-action="remove-group" data-group-index="${groupIndex}" title="删除属性" aria-label="删除属性">×</button></div></div>${fields}</article>`;
  }).join('');
}
function renderMenuOptionEditor() {
  const editor = document.querySelector('#menu-option-editor');
  if (editor) editor.innerHTML = menuOptionEditorMarkup();
}
function validateMenuOptionDrafts() {
  return (state.menuOptionDrafts || []).map((group, index) => {
    const name = String(group.name || '').trim();
    const values = (group.values || []).map(value => String(value || '').trim()).filter(Boolean);
    if (!name) throw new Error(`请填写属性 ${index + 1} 的名称`);
    if (!values.length) throw new Error(`请至少为“${name}”添加一个选项`);
    return { name, type: group.type === 'multiple' ? 'multiple' : 'single', required: Boolean(group.required), values };
  });
}
function updateMenuOptionDraft(control) {
  const group = state.menuOptionDrafts?.[Number(control.dataset.groupIndex)];
  if (!group) return;
  if (control.dataset.menuOptionField === 'value') group.values[Number(control.dataset.valueIndex)] = control.value;
  else if (control.dataset.menuOptionField === 'required') group.required = control.checked;
  else group[control.dataset.menuOptionField] = control.value;
}
document.addEventListener('input', event => {
  if (event.target.matches('[data-menu-option-field]')) updateMenuOptionDraft(event.target);
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-menu-option-field]')) updateMenuOptionDraft(event.target);
});
document.addEventListener('click', event => {
  const control = event.target.closest('[data-menu-option-action]');
  if (!control) return;
  const action = control.dataset.menuOptionAction;
  const groupIndex = Number(control.dataset.groupIndex);
  if (action === 'add-group') { state.menuOptionDrafts.push({ name: '', type: 'single', required: false, values: [''] }); state.menuEditingOptionIndex = state.menuOptionDrafts.length - 1; }
  if (action === 'edit') state.menuEditingOptionIndex = groupIndex;
  if (action === 'done') state.menuEditingOptionIndex = null;
  if (action === 'remove-group') { state.menuOptionDrafts.splice(groupIndex, 1); state.menuEditingOptionIndex = null; }
  if (action === 'add-value') state.menuOptionDrafts[groupIndex].values.push('');
  if (action === 'remove-value') state.menuOptionDrafts[groupIndex].values.splice(Number(control.dataset.valueIndex), 1);
  renderMenuOptionEditor();
});
function imagePickerModal(images, currentUrl) {
  const cards = images.length ? images.map(file => `<article class="menu-image-picker-card ${file.url === currentUrl ? 'is-selected' : ''}"><button type="button" data-menu-image-select="${file.url}" title="选择 ${escapeHtml(file.name)}"><img src="${file.url}" alt="${escapeHtml(file.name)}"><span>${escapeHtml(file.name)}</span></button><div><small>${imageFileSize(file.size)}</small><button class="menu-icon-button is-danger" type="button" ${file.inUse ? 'disabled title="图片正在使用中"' : `data-menu-image-delete="${escapeHtml(file.name)}" title="删除图片"`} aria-label="删除图片">×</button></div></article>`).join('') : '<div class="menu-image-picker-empty">还没有上传图片</div>';
  return `<div class="modal-backdrop menu-image-picker-backdrop"><section class="modal menu-image-picker-modal" role="dialog" aria-modal="true" aria-labelledby="image-picker-title"><div class="modal-head"><div><h2 id="image-picker-title">选择附件</h2><p class="hint">选择后会自动填入菜品图片。</p></div><button class="close" type="button" data-action="close-menu-image-picker" aria-label="关闭">×</button></div><div class="modal-content"><div class="menu-image-picker-tools"><label class="image-upload-button"><input id="menu-image-picker-upload" type="file" accept="image/png,image/jpeg,image/webp">上传图片</label><span>支持 PNG、JPG、WebP，最大 4MB</span></div><div class="menu-image-picker-grid">${cards}</div></div></section></div>`;
}
async function openMenuImagePicker() {
  const currentUrl = document.querySelector('#menu-dish-form [name="imageUrl"]')?.value || '';
  const images = await api('/api/admin/images');
  document.querySelector('.menu-image-picker-backdrop')?.remove();
  app.insertAdjacentHTML('beforeend', imagePickerModal(images, currentUrl));
}
document.addEventListener('click', async event => {
  const open = event.target.closest('[data-menu-open-image-picker]');
  const select = event.target.closest('[data-menu-image-select]');
  const remove = event.target.closest('[data-menu-image-delete]');
  const close = event.target.matches('[data-action="close-menu-image-picker"]') ? event.target : event.target.closest('button[data-action="close-menu-image-picker"]');
  if (!open && !select && !remove && !close) return;
  try {
    if (close) { document.querySelector('.menu-image-picker-backdrop')?.remove(); return; }
    if (open) { await openMenuImagePicker(); return; }
    if (select) {
      const imageUrl = document.querySelector('#menu-dish-form [name="imageUrl"]');
      if (imageUrl) imageUrl.value = select.dataset.menuImageSelect;
      document.querySelector('.menu-image-picker-backdrop')?.remove();
      return;
    }
    if (remove) {
      if (!window.confirm('确定删除这张未使用的图片吗？')) return;
      await api(`/api/admin/images/${encodeURIComponent(remove.dataset.menuImageDelete)}`, { method: 'DELETE' });
      toast('图片已删除');
      await openMenuImagePicker();
    }
  } catch (error) { toast(error.message || '图片操作失败'); }
});
document.addEventListener('change', async event => {
  if (event.target.id !== 'menu-image-picker-upload') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await upload(file);
    toast('图片已上传');
    await openMenuImagePicker();
  } catch (error) { toast(error.message || '图片上传失败'); }
});
// ===== 后台：点评与图片管理 =====
function reviewManagerModal(dish, reviews) {
  const meta = dish.reviewCount ? `${dish.reviewCount} 条点评 · ${dish.averageRating} 分` : '还没有点评';
  return `<div class="modal-backdrop" data-action="close-review-manager"><section class="modal admin-review-modal"><div class="modal-head"><div><h2>管理点评</h2><p class="hint">${escapeHtml(dish.name)} · ${meta}</p></div><button class="close" data-action="close-review-manager" aria-label="关闭">×</button></div><div class="modal-content"><div class="review-manager-dish"><img src="${image(dish.imageUrl)}" alt="${escapeHtml(dish.name)}"><div><strong>${escapeHtml(dish.name)}</strong><p>${meta}</p></div></div><div class="managed-review-list">${reviews.length ? reviews.map(review => `<article class="managed-review-item"><div class="managed-review-head"><div><strong>${escapeHtml(review.author)}</strong><span class="review-stars">${reviewStars(review.rating)}</span><time>${new Date(review.created_at).toLocaleString('zh-CN')}</time></div><span class="status ${review.visible ? '已展示' : '已隐藏'}">${review.visible ? '已展示' : '已隐藏'}</span></div><p>${escapeHtml(review.content)}</p><div class="admin-review-actions"><button class="secondary" data-toggle-review="${review.id}" data-review-visible="${review.visible ? 'true' : 'false'}">${review.visible ? '隐藏' : '恢复展示'}</button><button class="delete-button" data-delete-review="${review.id}" data-review-dish="${escapeHtml(review.dish_name)}">删除</button></div></article>`).join('') : '<div class="empty">这道菜还没有点评</div>'}</div></div></section></div>`;
}
function closeReviewManagerModal() {
  const backdrop = document.querySelector('.admin-review-modal')?.closest('.modal-backdrop');
  if (!backdrop || backdrop.classList.contains('is-closing')) return;
  state.reviewManagementDish = null;
  backdrop.classList.add('is-closing');
  window.setTimeout(() => backdrop.remove(), 200);
}
async function openReviewManagerModal(dish) {
  const reviews = await api(`/api/admin/reviews?dishId=${dish.id}`);
  state.reviewManagementDish = dish;
  document.querySelector('.admin-review-modal')?.closest('.modal-backdrop')?.remove();
  app.insertAdjacentHTML('beforeend', reviewManagerModal(dish, reviews));
}
adminReviews = async function(el) {
  const dishes = await api('/api/admin/review-summary');
  el.innerHTML = `<div class="panel"><div class="section-heading"><div><h2>点评管理</h2><p>按菜品查看、隐藏或删除点评。</p></div><span class="hint">${dishes.reduce((sum, dish) => sum + dish.review_count, 0)} 条点评</span></div><div class="review-dish-grid">${dishes.map(dish => `<button class="review-dish-card" data-manage-dish-reviews="${dish.id}" data-review-dish-name="${escapeHtml(dish.name)}" data-review-dish-image="${escapeHtml(dish.image_url)}" data-review-dish-count="${dish.review_count}" data-review-dish-average="${dish.average_rating}"><img src="${image(dish.image_url)}" alt="${escapeHtml(dish.name)}"><div><h3>${escapeHtml(dish.name)}</h3><p><span class="review-stars">${dish.review_count ? reviewStars(dish.average_rating) : '暂无评分'}</span></p><span>${dish.review_count} 条点评 · ${dish.review_count ? `${dish.average_rating} 分` : '等待首评'}</span></div></button>`).join('')}</div></div>`;
};
document.addEventListener('click', async event => {
  const card = event.target.closest('[data-manage-dish-reviews]');
  if (card) {
    try {
      await openReviewManagerModal({ id: Number(card.dataset.manageDishReviews), name: card.dataset.reviewDishName, imageUrl: card.dataset.reviewDishImage, reviewCount: Number(card.dataset.reviewDishCount), averageRating: Number(card.dataset.reviewDishAverage) });
    } catch (error) { toast(error.message); }
    return;
  }
  if (event.target.matches('[data-action="close-review-manager"]') || event.target.closest('button[data-action="close-review-manager"]')) {
    closeReviewManagerModal();
  }
});
function imageFileSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
async function adminImages(el) {
  const images = await api('/api/admin/images');
  el.innerHTML = `<div class="panel"><div class="section-heading"><div><h2>图片管理</h2><p>上传后的菜品图片和 Logo 会集中保存在这里。</p></div><label class="image-upload-button"><input id="image-library-upload" type="file" accept="image/png,image/jpeg,image/webp">上传图片</label></div><div class="image-library-grid">${images.length ? images.map(file => `<article class="image-library-card"><img src="${file.url}" alt="${escapeHtml(file.name)}"><div><strong>${escapeHtml(file.name)}</strong><p>${imageFileSize(file.size)} · ${new Date(file.modifiedAt).toLocaleDateString('zh-CN')}</p><span class="status ${file.inUse ? '已展示' : '已隐藏'}">${file.inUse ? '使用中' : '未使用'}</span></div><div class="image-library-actions"><button class="secondary" data-copy-image="${file.url}">复制地址</button><button class="delete-button" ${file.inUse ? 'disabled title="图片正在使用中"' : ''} data-delete-image="${escapeHtml(file.name)}">删除</button></div></article>`).join('') : '<div class="empty">还没有上传图片</div>'}</div></div>`;
}
document.addEventListener('change', async event => {
  if (event.target.id !== 'image-library-upload') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try { await upload(file); toast('图片已上传'); refreshAdminContent(); } catch (error) { toast(error.message); }
});
document.addEventListener('click', async event => {
  const copy = event.target.closest('[data-copy-image]');
  const remove = event.target.closest('[data-delete-image]');
  if (!copy && !remove) return;
  try {
    if (copy) {
      await navigator.clipboard.writeText(copy.dataset.copyImage);
      toast('图片地址已复制');
    }
    if (remove) {
      if (!window.confirm('确定删除这张未使用的图片吗？')) return;
      await api(`/api/admin/images/${encodeURIComponent(remove.dataset.deleteImage)}`, { method: 'DELETE' });
      toast('图片已删除');
      refreshAdminContent();
    }
  } catch (error) { toast(error.message || '操作失败'); }
});
document.addEventListener('click', async event => {
  const toggle = event.target.closest('[data-toggle-review]');
  const remove = event.target.closest('[data-delete-review]');
  if (!toggle && !remove) return;
  try {
    if (toggle) {
      const visible = toggle.dataset.reviewVisible === 'true';
      await api(`/api/admin/reviews/${toggle.dataset.toggleReview}`, { method: 'PUT', body: JSON.stringify({ visible: !visible }) });
      toast(visible ? '点评已隐藏' : '点评已恢复展示');
    }
    if (remove) {
      if (!window.confirm(`确定永久删除「${remove.dataset.reviewDish}」的这条点评吗？`)) return;
      await api(`/api/admin/reviews/${remove.dataset.deleteReview}`, { method: 'DELETE' });
      toast('点评已删除');
    }
    if (state.reviewManagementDish) await openReviewManagerModal(state.reviewManagementDish);
    else refreshAdminContent();
  } catch (error) { toast(error.message); }
});

// ===== 后台：菜单导入导出 =====
function menuTransferView(data) {
  return `<section class="menu-transfer-workspace"><header class="order-workspace-head"><div><h2>菜单导入导出</h2><p>导出当前分类和菜品，或从此前导出的文件恢复菜单。</p></div></header><div class="menu-transfer-grid"><section class="menu-transfer-panel"><div><h3>导出菜单</h3><p>将分类、菜品、规格、排序和图片地址保存为 JSON 文件，适合在迁移前备份。</p><div class="menu-transfer-summary"><span>当前菜单</span><strong><b>${data.categories.length}</b><small>个分类</small><i></i><b>${data.dishes.length}</b><small>道菜</small></strong></div></div><button class="primary" type="button" data-menu-export>下载菜单备份</button></section><section class="menu-transfer-panel"><div><h3>导入菜单</h3><p>仅接受本系统导出的 JSON 文件；订单、预约、点评和后台账号不会被导入。</p></div><form id="menu-transfer-form"><div class="field"><label>导入方式</label><select name="mode"><option value="replace">替换当前菜单</option><option value="append">追加到当前菜单</option></select><p class="menu-transfer-warning" data-menu-transfer-warning><strong>注意</strong><span>替换会移除现有分类、菜品及其点评，历史订单不受影响。</span></p></div><div class="menu-transfer-file"><label class="secondary" for="menu-import-file">选择导出文件</label><input id="menu-import-file" type="file" accept="application/json,.json"><span id="menu-import-file-name">尚未选择文件</span></div><p class="hint">若菜品图片使用 /uploads/ 地址，迁移时还需要复制旧项目的 data/uploads 文件夹。</p><p class="error hidden"></p><div class="form-actions"><button class="primary" type="submit">导入菜单</button></div></form></section></div></section>`;
}
function updateMenuTransferModeNotice(form) {
  const warning = form.querySelector('[data-menu-transfer-warning]');
  if (!warning) return;
  const replacing = form.elements.mode.value === 'replace';
  warning.classList.toggle('is-neutral', !replacing);
  warning.innerHTML = replacing
    ? '<strong>注意</strong><span>替换会移除现有分类、菜品及其点评，历史订单不受影响。</span>'
    : '<strong>追加</strong><span>会保留当前菜单，并将导入内容添加到现有分类和菜品之后。</span>';
}
async function adminMenuTransfer(el) {
  const data = await api('/api/admin/menu');
  el.innerHTML = menuTransferView(data);
}
document.addEventListener('click', async event => {
  if (!event.target.closest('[data-menu-export]')) return;
  try {
    const response = await fetch('/api/admin/menu-export');
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || '导出失败');
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob());
    link.download = `family-table-menu-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    toast('菜单备份已下载');
  } catch (error) { toast(error.message || '菜单导出失败'); }
});
document.addEventListener('change', async event => {
  if (event.target.id !== 'menu-import-file') return;
  const file = event.target.files?.[0];
  const name = document.querySelector('#menu-import-file-name');
  state.menuImportData = null;
  if (!file) { if (name) name.textContent = '尚未选择文件'; return; }
  try {
    state.menuImportData = JSON.parse(await file.text());
    if (name) name.textContent = file.name;
    toast('导出文件已读取');
  } catch (error) {
    if (name) name.textContent = '文件格式不正确';
    toast('请选择有效的 JSON 导出文件');
  }
});
document.addEventListener('change', event => {
  if (!event.target.matches('#menu-transfer-form [name="mode"]')) return;
  updateMenuTransferModeNotice(event.target.form);
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'menu-transfer-form') return;
  event.preventDefault();
  const error = form.querySelector('.error');
  error.classList.add('hidden');
  if (!state.menuImportData) { error.textContent = '请先选择并读取导出文件'; error.classList.remove('hidden'); return; }
  const mode = form.elements.mode.value;
  if (mode === 'replace' && !window.confirm('替换会删除当前所有分类、菜品和菜品点评。历史订单不会受影响，确定继续吗？')) return;
  try {
    const result = await api('/api/admin/menu-import', { method: 'POST', body: JSON.stringify({ mode, data: state.menuImportData }) });
    state.menuImportData = null;
    toast(`已${result.mode === 'replace' ? '替换' : '追加'} ${result.categories} 个分类和 ${result.dishes} 道菜`);
    await adminMenuTransfer(document.querySelector('#admin-content'));
  } catch (failure) { error.textContent = failure.message || '菜单导入失败'; error.classList.remove('hidden'); }
});
document.addEventListener('click', event => {
  const categoryButton = event.target.closest('[data-menu-category]');
  if (!categoryButton) return;
  const target = document.querySelector(`#menu-category-${categoryButton.dataset.menuCategory}`);
  if (!target) return;
  document.querySelectorAll('.category-rail-button').forEach(button => button.classList.remove('active'));
  categoryButton.classList.add('active');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
// ===== 前台：我的记录 / 预约 / 首页 =====
const SAVED_RECORDS_KEY = 'family-table-saved-records';
function toLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function suggestedBookingDate() {
  const schedule = state.site?.schedule || { days: [] };
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  for (let offset = 0; offset <= (schedule.maxDays || 30); offset += 1) {
    const candidate = new Date(start);
    candidate.setDate(start.getDate() + offset);
    if (schedule.days.includes(candidate.getDay())) return toLocalDate(candidate);
  }
  return toLocalDate(start);
}
function savedRecords() {
  try {
    const records = JSON.parse(localStorage.getItem(SAVED_RECORDS_KEY) || '[]');
    return Array.isArray(records) ? records.slice(0, 12) : [];
  } catch { return []; }
}
function rememberRecord(record) {
  const existing = savedRecords().filter(item => item.code !== record.code);
  existing.unshift({ code: record.code, token: record.token, createdAt: new Date().toISOString() });
  localStorage.setItem(SAVED_RECORDS_KEY, JSON.stringify(existing.slice(0, 12)));
}
function showBookingSuccess(result) {
  rememberRecord(result);
  location.hash = 'waiting';
  render();
}
function mealItems(items) {
  return items.length ? `<ul class="waiting-items">${items.map(item => `<li><div><strong>${escapeHtml(item.dish_name)}</strong><span>× ${item.quantity}</span></div>${item.options.length ? `<p>${escapeHtml(item.options.map(option => `${option.group}：${option.value}`).join('、'))}</p>` : ''}${item.note ? `<p>备注：${escapeHtml(item.note)}</p>` : ''}</li>`).join('')}</ul>` : '<p class="waiting-empty">这次只预约了时间，还没有点菜。</p>';
}
async function loadWaitingOrder() {
  const target = document.querySelector('#waiting-order');
  const record = savedRecords()[0];
  if (!target) return;
  if (!record) { target.innerHTML = '<div class="empty">没有找到刚提交的菜品。可以点右下角图标查看今天的记录。</div>'; return; }
  try {
    const order = await api(`/api/lookup?code=${encodeURIComponent(record.code)}&token=${encodeURIComponent(record.token)}`);
    if (document.querySelector('#waiting-order')) target.innerHTML = waitingOrderView(order);
  } catch (error) {
    target.innerHTML = `<div class="empty">暂时无法读取菜品：${escapeHtml(error.message)}</div>`;
  }
}
function myRecordsPage() {
  const records = savedRecords();
  return `<main class="page"><div class="narrow"><div class="section-heading"><div><h2>我的记录</h2><p>这台设备提交过的点菜和预约会自动保存在这里。</p></div><button class="text-button" data-route="lookup">换设备找回</button></div><div id="my-records-list" class="panel">${records.length ? '<p class="hint">正在更新记录状态...</p>' : '<div class="empty">还没有记录。提交点单或预约后，会自动显示在这里。</div>'}</div></div></main>`;
}
function recordCard(record) {
  const reservation = record.reservation;
  const items = record.items?.length ? record.items.map(item => `${escapeHtml(item.dish_name)} × ${item.quantity}`).join('、') : '仅预订时间';
  const timing = record.kind === 'immediate' ? '现在点菜，等待确认' : `${reservation.date} ${reservation.time_slot} · ${reservation.guests} 人`;
  return `<article class="saved-record"><div><div class="saved-record-head"><strong>${record.kind === 'reservation' ? '预订用餐' : '点菜记录'}</strong><span class="status ${record.status}">${record.status}</span></div><p>${escapeHtml(timing)}</p><p class="hint">${items}</p></div></article>`;
}
async function loadMyRecords() {
  const target = document.querySelector('#my-records-list');
  const records = savedRecords();
  if (!target || !records.length) return;
  const resolved = await Promise.all(records.map(async record => {
    try { return await api(`/api/lookup?code=${encodeURIComponent(record.code)}&token=${encodeURIComponent(record.token)}`); } catch { return null; }
  }));
  if (!document.querySelector('#my-records-list')) return;
  const active = resolved.filter(Boolean);
  target.innerHTML = active.length ? active.map(recordCard).join('') : '<div class="empty">暂时无法读取已保存的记录。可以联系管理员按称呼和时间核对。</div>';
}
function reservationModal() {
  const date = suggestedBookingDate();
  return `<div class="modal-backdrop" data-action="close-reservation"><section class="modal reservation-modal"><div class="modal-head"><div><h2>订用餐时间</h2><p class="hint">选一个方便的时间，确认后家里就会安排。</p></div><button class="close" data-action="close-reservation" aria-label="关闭">×</button></div><div class="modal-content"><form id="booking-form" data-kind="reservation"><div class="form-grid"><div class="field"><label>怎么称呼您？</label><input name="contactName" maxlength="50" required placeholder="例如：小王"></div><div class="field"><label>怎么联系您？</label><input name="contactInfo" maxlength="100" required placeholder="手机号或微信号"></div><div class="field"><label>哪天吃？</label><input name="date" type="date" min="${dateValue(0)}" max="${dateValue(state.site.schedule.maxDays || 30)}" value="${date}" required></div><div class="field"><label>什么时候吃？</label><select name="timeSlot" required><option value="">正在查看可订时间...</option></select></div><div class="field"><label>大概几个人？</label><input name="guests" type="number" min="1" max="30" value="2" required></div><div class="field full"><label>还有什么要说？</label><textarea name="note" maxlength="300" placeholder="例如：预计晚到 10 分钟"></textarea></div></div><p class="hint" id="slot-hint"></p><p class="error hidden" id="booking-error"></p><div class="form-actions"><button class="primary" type="submit">提交预订</button></div></form><div id="booking-result"></div><section class="reservation-history"><div class="reservation-history-head"><h3>我的预约</h3><span>自动保存在这台设备</span></div><div id="reservation-history"><p class="hint">正在读取预约记录...</p></div></section></div></section></div>`;
}
async function loadReservationHistory() {
  const target = document.querySelector('#reservation-history');
  const records = savedRecords();
  if (!target) return;
  if (!records.length) { target.innerHTML = '<p class="hint">还没有预约记录。提交后会自动显示在这里。</p>'; return; }
  const resolved = await Promise.all(records.map(async record => {
    try { return await api(`/api/lookup?code=${encodeURIComponent(record.code)}&token=${encodeURIComponent(record.token)}`); } catch { return null; }
  }));
  if (!document.querySelector('#reservation-history')) return;
  const bookings = resolved.filter(record => record && record.kind !== 'immediate').slice(0, 5);
  target.innerHTML = bookings.length ? bookings.map(recordCard).join('') : '<p class="hint">还没有预约记录。提交后会自动显示在这里。</p>';
}
function openReservationModal() {
  document.querySelector('.reservation-modal')?.closest('.modal-backdrop')?.remove();
  app.insertAdjacentHTML('beforeend', reservationModal());
  loadSlots(document.querySelector('.reservation-modal #booking-form'));
  loadReservationHistory();
}
function liveClockText(date = new Date()) {
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
  return `${date.getMonth() + 1}月${date.getDate()}日 周${weekday} ${time}`;
}
function updateLiveClock() {
  const now = new Date();
  document.querySelectorAll('.live-clock').forEach(clock => {
    clock.textContent = liveClockText(now);
    clock.dateTime = now.toISOString();
  });
}
window.setInterval(updateLiveClock, 1000);
bookingForm = function(kind) {
  const modeSwitch = kind === 'immediate' || kind === 'order' ? `<nav class="order-mode-switch" aria-label="点单方式"><button class="${kind === 'immediate' ? 'active' : ''}" data-route="quick-order">立即点菜</button><button class="${kind === 'order' ? 'active' : ''}" data-route="checkout">预约用餐</button></nav>` : '';
  const immediate = kind === 'immediate'; const hasItems = kind === 'order' || immediate;
  const title = immediate ? '现在点菜' : kind === 'order' ? '预订用餐时间' : '只订用餐时间';
  const items = hasItems ? `<div class="panel"><strong>已选菜品 ${cartCount()} 道</strong><ul class="summary-list">${state.cart.map(item => `<li>${escapeHtml(item.name)} × ${item.quantity}<br><span class="hint">${escapeHtml(item.options.map(x => `${x.group}：${x.value}`).join('、'))}</span></li>`).join('')}</ul></div>` : '<div class="note-box">先把时间订下来。管理员确认后，这个时段才算正式安排好。</div>';
  const bookingFields = immediate ? '' : `<div class="field"><label>哪天吃？</label><input name="date" type="date" min="${dateValue(0)}" max="${dateValue(state.site.schedule.maxDays || 30)}" value="${suggestedBookingDate()}" required></div><div class="field"><label>什么时候吃？</label><select name="timeSlot" required><option value="">正在查看可订时间...</option></select></div><div class="field"><label>大概几个人？</label><input name="guests" type="number" min="1" max="30" value="2" required></div>`;
  const description = immediate ? '不订时间，先把想吃的菜告诉家里。确认后再开始准备。' : kind === 'order' ? '选好时间后再提交菜品，家里确认后就安排这顿饭。' : '不点菜也可以，先选一个方便的用餐时间。';
  return `<main class="page"><div class="narrow"><div class="section-heading"><div><h2>${title}</h2><p>${description}</p></div></div>${items}${modeSwitch}<form class="panel" id="booking-form" data-kind="${kind}"><div class="form-grid"><div class="field"><label>怎么称呼您？</label><input name="contactName" maxlength="50" required placeholder="例如：小王"></div><div class="field"><label>怎么联系您？</label><input name="contactInfo" maxlength="100" required placeholder="手机号或微信号"></div>${bookingFields}<div class="field full"><label>还有什么要说？</label><textarea name="note" maxlength="300" placeholder="例如：预计晚到 10 分钟；菜品统一少盐"></textarea></div></div><p class="hint" id="slot-hint">${immediate ? '现在点菜不会占用预约时段。' : ''}</p><p class="error hidden" id="booking-error"></p><div class="form-actions"><button class="secondary" type="button" data-route="menu">返回菜单</button><button class="primary" type="submit">${immediate ? '提交点菜' : kind === 'order' ? '确认时间并提交' : '提交预订'}</button></div></form><div id="booking-result"></div></div></main>`;
};

document.addEventListener('click', event => {
  if (event.target.closest('[data-action="open-today-meals"]')) { document.querySelector('.today-meals-backdrop')?.remove(); app.insertAdjacentHTML('beforeend', todayMealsDrawer()); loadTodayMeals(); return; }
  if (event.target.matches('[data-action="close-today-meals"]') || event.target.closest('button[data-action="close-today-meals"]')) { document.querySelector('.today-meals-backdrop')?.remove(); return; }
  if (event.target.closest('[data-action="open-reservation"]')) { openReservationModal(); return; }
  if (event.target.matches('[data-action="close-reservation"]') || event.target.closest('button[data-action="close-reservation"]')) {
    document.querySelector('.reservation-modal')?.closest('.modal-backdrop')?.remove();
    if (location.hash === '#reserve') location.hash = 'menu';
  }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'password-form') return;
  event.preventDefault();
  const error = form.querySelector('#password-error');
  error.classList.add('hidden');
  try {
    await api('/api/admin/password', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    toast('后台密码已更新');
  } catch (failure) {
    error.textContent = failure.message;
    error.classList.remove('hidden');
  }
});
window.addEventListener('hashchange', () => render());


function orderCreatedAtLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function dishCardStats(dish) {
  const rating = dish.reviewCount ? `${Number(dish.averageRating).toFixed(1)} 分` : '暂无评分';
  return `<div class="dish-card-stats"><span>&#9733; ${rating}</span><span>已点 ${dish.orderCount || 0} 次</span></div>`;
}
function closeOverlayAnimated(overlay, afterClose) {
  if (!overlay || overlay.classList.contains('is-closing')) return;
  overlay.classList.add('is-closing');
  window.setTimeout(() => { afterClose?.(); overlay.remove(); }, 210);
}
document.addEventListener('click', event => {
  const reservationOverlay = event.target.matches('.modal-backdrop') ? event.target : event.target.closest('.reservation-modal')?.closest('.modal-backdrop');
  const closeReservation = event.target.matches('[data-action="close-reservation"]') || event.target.closest('button[data-action="close-reservation"]');
  if (closeReservation && reservationOverlay) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOverlayAnimated(reservationOverlay, () => { if (location.hash === '#reserve') location.hash = 'menu'; });
    return;
  }
  const dishOverlay = event.target.matches('.modal-backdrop') ? event.target : event.target.closest('.dish-modal')?.closest('.modal-backdrop');
  const closeDish = event.target.matches('[data-action="close-dish"]') || event.target.closest('button[data-action="close-dish"]');
  if (closeDish && dishOverlay) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOverlayAnimated(dishOverlay, () => { state.selected = null; render(); });
    return;
  }
  const closeCart = event.target.matches('[data-action="close-cart"]') || event.target.closest('button[data-action="close-cart"]');
  if (closeCart) {
    const overlay = event.target.closest('.drawer-backdrop');
    if (overlay) { event.preventDefault(); event.stopImmediatePropagation(); closeOverlayAnimated(overlay); }
    return;
  }
  const closeToday = event.target.matches('[data-action="close-today-meals"]') || event.target.closest('button[data-action="close-today-meals"]');
  if (closeToday) {
    const overlay = event.target.closest('.today-meals-backdrop');
    if (overlay) { event.preventDefault(); event.stopImmediatePropagation(); closeOverlayAnimated(overlay); }
  }
}, true);
orderWorkCard = function(order) {
  const type = order.kind === 'immediate'
    ? { key: 'immediate', label: '立即点菜' }
    : order.kind === 'reservation'
      ? { key: 'reservation', label: '仅预约' }
      : { key: 'scheduled', label: '预约点单' };
  const itemSummary = order.items.length
    ? `${escapeHtml(order.items.slice(0, 2).map(item => `${item.dish_name} x${item.quantity}`).join('、'))}${order.items.length > 2 ? ` 等 ${order.items.length} 道` : ''}`
    : '仅预约时间，尚未选择菜品';
  const requestNote = order.note ? `<div class="merchant-order-note"><strong>顾客备注</strong><span>${escapeHtml(order.note)}</span></div>` : '';
  const actions = orderQuickActions(order);
  return `<article class="order-work-card merchant-order-row order-type-${type.key}"><div class="merchant-order-state"><span class="status ${order.status}">${order.status}</span><small>${type.label}</small></div><div class="merchant-order-schedule"><strong>${order.date} ${order.time_slot}</strong><span>下单 ${orderCreatedAtLabel(order.created_at)}</span><span>${order.guests} 人 · ${order.code}</span></div><div class="merchant-order-items"><strong>${itemSummary}</strong><span>${order.items.length ? '已提交菜品' : '待安排菜品'}</span></div><div class="merchant-order-contact"><strong>${escapeHtml(order.contact_name)}</strong><a href="tel:${escapeHtml(order.contact_info)}">${escapeHtml(order.contact_info)}</a></div><div class="merchant-order-actions">${actions || '<span class="merchant-order-complete">已处理</span>'}</div>${requestNote}</article>`;
};

adminLogin = function() {
  app.innerHTML = adminLayout(`<main class="admin-login-page"><section class="admin-login-panel"><div class="admin-login-heading"><p>家庭厨房</p><h1>管理入口</h1><span>输入管理密码后进入后台</span></div><form id="admin-login"><div class="field"><label>管理密码</label><input name="password" required type="password" autocomplete="current-password" autofocus placeholder="请输入管理密码"></div><label class="admin-remember"><input name="remember" type="checkbox"><span>保持登录 30 天</span></label><p class="error hidden" id="admin-error"></p><button class="primary admin-login-submit">进入管理</button></form></section></main>`);
};
document.addEventListener('click', event => {
  const logout = event.target.closest('[data-action="logout"]');
  if (!logout || window.confirm('确定要退出后台管理吗？')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
// Menu maintenance is intentionally kept in one workspace: categories are the
// left anchor and all destructive or publishing actions are explicit controls.
menuAdminDishModal = function(data, dish = null) {
  state.menuOptionDrafts = (dish?.options || []).map(group => ({ ...group, values: [...group.values] }));
  state.menuEditingOptionIndex = null;
  const title = dish ? '编辑菜品' : '新增菜品';
  return `<div class="modal-backdrop" data-action="close-menu-dish-modal"><section class="modal menu-editor-modal" role="dialog" aria-modal="true" aria-labelledby="menu-editor-title"><div class="modal-head"><div><h2 id="menu-editor-title">${title}</h2><p class="hint">保存后会立即更新公开菜单。</p></div><button class="close" type="button" data-action="close-menu-dish-modal" aria-label="关闭">×</button></div><div class="modal-content"><form id="menu-dish-form"><input type="hidden" name="id" value="${dish?.id || ''}"><div class="form-grid"><div class="field"><label>菜品名称</label><input name="name" required maxlength="80" value="${escapeHtml(dish?.name || '')}" placeholder="例如：家常豆腐"></div><div class="field"><label>所属分类</label><select name="categoryId" required>${data.categories.map(category => `<option value="${category.id}" ${dish?.category_id === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select></div><div class="field full"><label>菜品描述</label><textarea name="description" maxlength="300" placeholder="一句简短说明">${escapeHtml(dish?.description || '')}</textarea></div><div class="field full"><label>图片URL</label><div class="menu-image-field"><input name="imageUrl" value="${escapeHtml(dish?.image_url || '')}" placeholder="https://..." aria-label="图片URL"><button class="secondary" type="button" data-menu-open-image-picker>选择附件</button></div></div><div class="field full"><label>上传图片</label><input name="imageFile" type="file" accept="image/png,image/jpeg,image/webp"></div><div class="field full"><label>规格与属性</label><div id="menu-option-editor" class="menu-option-editor">${menuOptionEditorMarkup()}</div><button class="secondary menu-add-option-button" type="button" data-menu-option-action="add-group">+ 添加属性</button></div><label class="menu-editor-status"><input name="active" type="checkbox" ${dish?.active === 0 ? '' : 'checked'}> 上架并在公开菜单展示</label></div><p class="error hidden" id="menu-dish-error"></p><div class="form-actions"><button class="secondary" type="button" data-action="close-menu-dish-modal">取消</button><button class="primary" type="submit">${dish ? '保存修改' : '添加菜品'}</button></div></form></div></section></div>`;
};
state.menuAdminFilters = state.menuAdminFilters || { categoryId: 'all', query: '', status: 'all' };
state.menuAdminPagination = state.menuAdminPagination || { page: 1, pageSize: 20 };
const menuPageSizes = [10, 20, 30, 50, 100];
function menuPropertyTags(options) {
  if (!options.length) return '<span class="menu-property-empty">未设置</span>';
  const visible = options.slice(0, 2).map(option => `<span class="menu-property-tag">${escapeHtml(option.name)}${option.required ? ' · 必选' : ''}</span>`).join('');
  const more = options.length > 2 ? `<span class="menu-property-more">+${options.length - 2}</span>` : '';
  return `<div class="menu-property-tags" title="${escapeHtml(options.map(option => `${option.name}：${option.values.join('、')}`).join('；'))}">${visible}${more}</div>`;
}
function menuAdminRow(dish, category) {
  const activeLabel = dish.active ? '已上架' : '已下架';
  return `<tr data-menu-dish-row="${dish.id}"><td><label class="table-checkbox"><input type="checkbox" data-menu-select="${dish.id}" aria-label="选择 ${escapeHtml(dish.name)}"><span></span></label></td><td><div class="menu-dish-cell"><img src="${image(dish.image_url)}" alt=""><strong>${escapeHtml(dish.name)}</strong></div></td><td><span class="menu-table-category">${escapeHtml(category.name)}</span></td><td>${menuPropertyTags(dish.options)}</td><td><button class="menu-status-switch ${dish.active ? 'is-active' : ''}" type="button" data-menu-toggle="${dish.id}" role="switch" aria-checked="${dish.active ? 'true' : 'false'}" aria-label="${dish.name}${activeLabel}" title="${activeLabel}"><span></span></button><small>${activeLabel}</small></td><td><div class="menu-table-actions"><button class="secondary" type="button" data-menu-edit="${dish.id}">编辑</button><button class="delete-button" type="button" data-menu-delete-one="${dish.id}">删除</button></div></td></tr>`;
}
function menuPaginationMarkup(total, page, totalPages, pageSize) {
  const pageOptions = Array.from({ length: totalPages }, (_, index) => `<option value="${index + 1}" ${page === index + 1 ? 'selected' : ''}>${index + 1} / ${totalPages}</option>`).join('');
  const pageSizeOptions = menuPageSizes.map(size => `<option value="${size}" ${pageSize === size ? 'selected' : ''}>${size}</option>`).join('');
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  return `<footer class="menu-table-footer"><span>显示 ${start}-${end}，共 ${total} 道菜</span><div class="menu-pagination" aria-label="菜单分页"><button class="menu-page-button" type="button" data-menu-page-direction="prev" ${page <= 1 ? 'disabled' : ''} aria-label="上一页">&#8249;</button><button class="menu-page-button" type="button" data-menu-page-direction="next" ${page >= totalPages ? 'disabled' : ''} aria-label="下一页">&#8250;</button><label><select data-menu-page aria-label="当前页">${pageOptions}</select></label><span>页</span><label><select data-menu-page-size aria-label="每页条数">${pageSizeOptions}</select></label><span>条/页</span></div></footer>`;
}
function renderMenuAdminTable(data) {
  const filters = state.menuAdminFilters;
  const pagination = state.menuAdminPagination;
  const grouped = data.categories.map(category => ({ ...category, dishes: data.dishes.filter(dish => dish.category_id === category.id) }));
  const normalizedQuery = filters.query.trim().toLowerCase();
  // 移动端分类抽屉所需：当前分类名、分类选择列表、管理区行
  const currentCategoryName = filters.categoryId === 'all' ? '全部' : (data.categories.find(category => String(category.id) === String(filters.categoryId))?.name || '全部');
  const pickerItems = `<button type="button" class="${filters.categoryId === 'all' ? 'active' : ''}" data-menu-category-filter="all">🍱 全部菜品<span>${data.dishes.length} 道</span></button>${data.categories.map(category => `<button type="button" class="${String(category.id) === String(filters.categoryId) ? 'active' : ''}" data-menu-category-filter="${category.id}">${escapeHtml(category.name)}<span>${grouped.find(group => group.id === category.id)?.dishes.length || 0} 道</span></button>`).join('')}`;
  const manageRows = data.categories.map((category, index) => `<div class="menu-category-tool-row" data-menu-category-row="${category.id}"><span class="menu-category-order">${index + 1}</span><input data-menu-category-name="${category.id}" value="${escapeHtml(category.name)}" data-original-name="${escapeHtml(category.name)}" maxlength="50" aria-label="分类名称"><div><button class="menu-icon-button" type="button" data-menu-category-move="${category.id}" data-direction="up" title="上移" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button><button class="menu-icon-button" type="button" data-menu-category-move="${category.id}" data-direction="down" title="下移" aria-label="下移" ${index === data.categories.length - 1 ? 'disabled' : ''}>↓</button><button class="menu-icon-button is-danger ${(grouped.find(group => group.id === category.id)?.dishes.length || 0) ? 'is-locked' : ''}" type="button" data-menu-category-delete="${category.id}" data-menu-category-name="${escapeHtml(category.name)}" data-menu-category-count="${grouped.find(group => group.id === category.id)?.dishes.length || 0}" title="删除分类" aria-label="删除分类">×</button></div></div>`).join('');
  const filteredDishes = data.dishes.filter(dish => (filters.categoryId === 'all' || dish.category_id === Number(filters.categoryId)) && (filters.status === 'all' || (filters.status === 'active' ? dish.active : !dish.active)) && (!normalizedQuery || `${dish.name} ${dish.description}`.toLowerCase().includes(normalizedQuery)));
  const pageSize = menuPageSizes.includes(Number(pagination.pageSize)) ? Number(pagination.pageSize) : 20;
  const totalPages = Math.max(1, Math.ceil(filteredDishes.length / pageSize));
  const page = Math.min(Math.max(1, Number(pagination.page) || 1), totalPages);
  pagination.page = page;
  pagination.pageSize = pageSize;
  const pageDishes = filteredDishes.slice((page - 1) * pageSize, page * pageSize);
  const rows = pageDishes.map(dish => menuAdminRow(dish, data.categories.find(category => category.id === dish.category_id) || { name: '未分类' })).join('');
  const categoryItems = `<button class="menu-category-filter ${filters.categoryId === 'all' ? 'active' : ''}" type="button" data-menu-category-filter="all"><span>全部分类</span><b>${data.dishes.length} 道</b></button>${grouped.map(category => `<button class="menu-category-filter ${String(category.id) === String(filters.categoryId) ? 'active' : ''}" type="button" data-menu-category-filter="${category.id}"><span>${escapeHtml(category.name)}</span><b>${category.dishes.length} 道</b></button>`).join('')}`;
  return `<section class="menu-admin-layout"><aside class="menu-admin-sidebar"><div class="menu-sidebar-heading"><h2>分类</h2><p>按分类筛选菜品</p></div><nav class="menu-category-filters" aria-label="菜品分类">${categoryItems}</nav><form id="menu-category-create" class="menu-category-create"><input name="name" required maxlength="50" placeholder="新分类名称"><button class="secondary">新增分类</button></form><details class="menu-category-tools"><summary>管理分类</summary><div class="menu-category-order-bar"><span class="hint">用 ↑↓ 调整顺序，完成后统一保存</span><button class="primary menu-category-save-order" type="button" data-menu-category-save-order disabled>保存顺序</button></div><div class="menu-category-list">${grouped.map((category, index) => `<div class="menu-category-tool-row" data-menu-category-row="${category.id}"><span class="menu-category-order">${index + 1}</span><input data-menu-category-name="${category.id}" value="${escapeHtml(category.name)}" data-original-name="${escapeHtml(category.name)}" maxlength="50" aria-label="分类名称"><div><button class="menu-icon-button" type="button" data-menu-category-move="${category.id}" data-direction="up" title="上移" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button><button class="menu-icon-button" type="button" data-menu-category-move="${category.id}" data-direction="down" title="下移" aria-label="下移" ${index === grouped.length - 1 ? 'disabled' : ''}>↓</button><button class="menu-icon-button is-danger ${(category.dishes.length) ? 'is-locked' : ''}" type="button" data-menu-category-delete="${category.id}" data-menu-category-name="${escapeHtml(category.name)}" data-menu-category-count="${category.dishes.length}" title="删除分类" aria-label="删除分类">×</button></div></div>`).join('')}</div></details></aside><div class="menu-admin-main"><div class="menu-admin-toolbar"><input type="search" data-menu-search value="${escapeHtml(filters.query)}" placeholder="搜索菜品名称" aria-label="搜索菜品名称"><select data-menu-status-filter aria-label="上架状态"><option value="all" ${filters.status === 'all' ? 'selected' : ''}>全部状态</option><option value="active" ${filters.status === 'active' ? 'selected' : ''}>仅已上架</option><option value="inactive" ${filters.status === 'inactive' ? 'selected' : ''}>仅已下架</option></select><button class="secondary menu-category-trigger" type="button" data-action="open-menu-category-picker">📂 ${escapeHtml(currentCategoryName)} ▾</button><button class="primary" type="button" data-menu-add>+ 新增菜品</button></div><div class="menu-bulk-bar"><label class="table-checkbox bulk-select"><input type="checkbox" data-menu-select-all aria-label="选择当前页全部菜品"><span></span><b>全选本页</b></label><span data-menu-selected-count>已选 0 道</span><div class="menu-bulk-actions"><button class="secondary" type="button" data-menu-batch="publish" disabled>批量上架</button><button class="secondary" type="button" data-menu-batch="unpublish" disabled>批量下架</button><button class="delete-button" type="button" data-menu-batch="delete" disabled>批量删除</button></div></div><div class="menu-table-wrap"><table class="menu-admin-table"><thead><tr><th><span class="sr-only">选择</span></th><th>菜品名称</th><th>菜品分类</th><th>属性</th><th>上架/下架</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="menu-table-empty">没有符合当前筛选条件的菜品。</td></tr>'}</tbody></table></div>${menuPaginationMarkup(filteredDishes.length, page, totalPages, pageSize)}</div></section><div class="menu-category-picker-backdrop" data-action="close-menu-category-picker" hidden></div><div class="menu-category-picker"><header class="menu-category-picker-head"><div><h3>选择分类</h3><p class="hint">按分类筛选菜品</p></div><button class="close" type="button" data-action="close-menu-category-picker" aria-label="关闭">×</button></header><nav class="menu-category-picker-list" aria-label="菜品分类">${pickerItems}</nav><div class="menu-category-picker-foot"><button type="button" class="secondary menu-category-manage-trigger" data-action="open-menu-category-manager">⚙ 管理分类</button></div></div><div class="menu-category-manager-backdrop" data-action="close-menu-category-manager" hidden></div><div class="menu-category-manager"><header class="menu-category-manager-head"><div><h3>分类管理</h3><p class="hint">直接改名称即可自动保存；用 ↑↓ 调整顺序后点“保存顺序”</p></div><button class="close" type="button" data-action="close-menu-category-manager" aria-label="关闭">×</button></header><form id="menu-category-create" class="menu-category-create"><input name="name" required maxlength="50" placeholder="新分类名称"><button class="secondary">新增分类</button></form><div class="menu-category-order-bar"><span class="hint">用 ↑↓ 调整顺序，完成后统一保存</span><button class="primary menu-category-save-order" type="button" data-menu-category-save-order disabled>保存顺序</button></div><div class="menu-category-list">${manageRows}</div></div>`;
}
adminMenu = async function(el) {
  const data = await api('/api/admin/menu');
  state.menuAdminData = data;
  el.innerHTML = renderMenuAdminTable(data);
};
function updateMenuBulkControls() {
  const selected = [...document.querySelectorAll('[data-menu-select]:checked')];
  const count = document.querySelector('[data-menu-selected-count]');
  if (count) count.textContent = `已选 ${selected.length} 道`;
  document.querySelectorAll('[data-menu-batch]').forEach(button => { button.disabled = !selected.length; });
  const all = document.querySelectorAll('[data-menu-select]');
  const selectAll = document.querySelector('[data-menu-select-all]');
  if (selectAll) { selectAll.checked = Boolean(all.length) && selected.length === all.length; selectAll.indeterminate = Boolean(selected.length) && selected.length < all.length; }
}
function closeMenuDishModal() {
  const backdrop = document.querySelector('.menu-editor-modal')?.closest('.modal-backdrop');
  if (!backdrop || backdrop.classList.contains('is-closing')) return;
  backdrop.classList.add('is-closing');
  window.setTimeout(() => backdrop.remove(), 190);
}
async function saveMenuDishForm(form) {
  const errorEl = form.querySelector('.error');
  errorEl?.classList.add('hidden');
  try {
    const fields = Object.fromEntries(new FormData(form));
    const imageUrl = fields.imageFile?.size ? await upload(fields.imageFile) : fields.imageUrl;
    const body = {
      categoryId: Number(fields.categoryId),
      name: fields.name,
      description: fields.description,
      imageUrl,
      options: validateMenuOptionDrafts(),
      active: form.elements.active.checked
    };
    await api(fields.id ? `/api/admin/dishes/${fields.id}` : '/api/admin/dishes', { method: fields.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    closeMenuDishModal();
    toast(fields.id ? '菜品已更新' : '菜品已添加');
    refreshAdminContent();
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message; errorEl.classList.remove('hidden'); }
    else toast(error.message);
  }
}
function bindMenuDishModal() {
  const form = document.querySelector('#menu-dish-form');
  const backdrop = form?.closest('.modal-backdrop');
  if (!form || !backdrop) return;
  form.addEventListener('submit', event => {
    event.preventDefault();
    event.stopPropagation();
    saveMenuDishForm(form);
  });
  backdrop.querySelectorAll('[data-action="close-menu-dish-modal"]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      closeMenuDishModal();
    });
  });
}
document.addEventListener('change', async event => {
  if (event.target.matches('[data-menu-select]')) updateMenuBulkControls();
  if (event.target.matches('[data-menu-select-all]')) {
    document.querySelectorAll('[data-menu-select]').forEach(input => { input.checked = event.target.checked; });
    updateMenuBulkControls();
  }
  if (event.target.matches('[data-menu-category-name]')) {
    const input = event.target;
    const name = input.value.trim();
    if (!name) { input.value = input.dataset.originalName || ''; toast('分类名称不能为空'); return; }
    try {
      await api(`/api/admin/categories/${input.dataset.menuCategoryName}`, { method: 'PUT', body: JSON.stringify({ name }) });
      input.dataset.originalName = name;
      toast('分类名称已保存');
    } catch (error) { toast(error.message); input.value = input.dataset.originalName || ''; }
  }
});
document.addEventListener('click', async event => {
  const add = event.target.closest('[data-menu-add]');
  const edit = event.target.closest('[data-menu-edit]');
  const toggle = event.target.closest('[data-menu-toggle]');
  const remove = event.target.closest('[data-menu-delete-one]');
  const batch = event.target.closest('[data-menu-batch]');
  const moveCategory = event.target.closest('[data-menu-category-move]');
  const saveOrder = event.target.closest('[data-menu-category-save-order]');
  const deleteCategory = event.target.closest('[data-menu-category-delete]');
  const close = event.target.matches('[data-action="close-menu-dish-modal"]') ? event.target : event.target.closest('button[data-action="close-menu-dish-modal"]');
  if (close) { closeMenuDishModal(); return; }
  // 删除分类：非空分类点击时提示原因，不静默禁用
  if (deleteCategory) {
    const count = Number(deleteCategory.dataset.menuCategoryCount) || 0;
    if (count > 0) { toast(`该分类下还有 ${count} 道菜品，请先删除或移动菜品后再删除分类`); return; }
    if (!window.confirm(`确定删除分类「${deleteCategory.dataset.menuCategoryName}」吗？`)) return;
    await api(`/api/admin/categories/${deleteCategory.dataset.menuCategoryDelete}`, { method: 'DELETE' });
    toast('分类已删除');
    refreshAdminContent();
    return;
  }
  // 分类排序：点 ↑↓ 只做本地重排（不请求、不刷新），完成后统一保存
  if (moveCategory) {
    const rows = [...document.querySelectorAll('[data-menu-category-row]')];
    const from = rows.findIndex(row => row.dataset.menuCategoryRow === moveCategory.dataset.menuCategoryMove);
    const to = from + (moveCategory.dataset.direction === 'up' ? -1 : 1);
    if (from < 0 || to < 0 || to >= rows.length) return;
    const list = moveCategory.closest('.menu-category-list');
    if (!list) return;
    if (moveCategory.dataset.direction === 'up') list.insertBefore(rows[from], rows[to]);
    else list.insertBefore(rows[from], rows[to].nextSibling);
    const updated = [...list.querySelectorAll('[data-menu-category-row]')];
    updated.forEach((row, index) => {
      row.querySelector('.menu-category-order').textContent = index + 1;
      const up = row.querySelector('[data-direction="up"]');
      const down = row.querySelector('[data-direction="down"]');
      if (up) up.disabled = index === 0;
      if (down) down.disabled = index === updated.length - 1;
    });
    const saveBtn = document.querySelector('[data-menu-category-save-order]');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.add('has-changes'); }
    return;
  }
  if (saveOrder) {
    const rows = [...document.querySelectorAll('[data-menu-category-row]')].filter(row => row.offsetParent !== null);
    await api('/api/admin/categories/order', { method: 'PUT', body: JSON.stringify({ ids: rows.map(row => Number(row.dataset.menuCategoryRow)) }) });
    saveOrder.disabled = true;
    saveOrder.classList.remove('has-changes');
    toast('分类顺序已保存');
    return;
  }
  if (!add && !edit && !toggle && !remove && !batch) return;
  try {
    const data = await api('/api/admin/menu');
    if (add || edit) {
      const dish = edit ? data.dishes.find(item => item.id === Number(edit.dataset.menuEdit)) : null;
      app.insertAdjacentHTML('beforeend', menuAdminDishModal(data, dish || (add.dataset.menuCategory ? { category_id: Number(add.dataset.menuCategory), active: 1 } : null)));
      bindMenuDishModal();
      return;
    }
    if (toggle) {
      const dish = data.dishes.find(item => item.id === Number(toggle.dataset.menuToggle));
      if (!dish) throw new Error('菜品不存在');
      await api(`/api/admin/dishes/${dish.id}`, { method: 'PUT', body: JSON.stringify({ categoryId: dish.category_id, name: dish.name, description: dish.description, imageUrl: dish.image_url, options: dish.options, active: !dish.active, sortOrder: dish.sort_order }) });
      toast(dish.active ? '菜品已下架' : '菜品已上架');
    }
    if (remove) {
      const dish = data.dishes.find(item => item.id === Number(remove.dataset.menuDeleteOne));
      if (!dish || !window.confirm(`确定永久删除「${dish.name}」吗？相关点评也会一并删除。`)) return;
      await api(`/api/admin/dishes/${dish.id}`, { method: 'DELETE' });
      toast('菜品已删除');
    }
    if (batch) {
      const ids = [...document.querySelectorAll('[data-menu-select]:checked')].map(input => Number(input.dataset.menuSelect));
      const dishes = data.dishes.filter(dish => ids.includes(dish.id));
      if (batch.dataset.menuBatch === 'delete' && !window.confirm(`确定永久删除选中的 ${dishes.length} 道菜吗？相关点评也会一并删除。`)) return;
      await Promise.all(dishes.map(dish => batch.dataset.menuBatch === 'delete'
        ? api(`/api/admin/dishes/${dish.id}`, { method: 'DELETE' })
        : api(`/api/admin/dishes/${dish.id}`, { method: 'PUT', body: JSON.stringify({ categoryId: dish.category_id, name: dish.name, description: dish.description, imageUrl: dish.image_url, options: dish.options, active: batch.dataset.menuBatch === 'publish', sortOrder: dish.sort_order }) }
      )));
      toast(batch.dataset.menuBatch === 'delete' ? '选中菜品已删除' : batch.dataset.menuBatch === 'publish' ? '选中菜品已上架' : '选中菜品已下架');
    }
    refreshAdminContent();
  } catch (error) { toast(error.message); }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'menu-dish-form' && form.id !== 'menu-category-create') return;
  event.preventDefault();
  try {
    if (form.id === 'menu-category-create') {
      const fields = Object.fromEntries(new FormData(form));
      await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name: fields.name }) });
      toast('分类已添加');
      refreshAdminContent();
      return;
    }
    await saveMenuDishForm(form);
  } catch (error) {
    const errorEl = form.querySelector('.error');
    if (errorEl) { errorEl.textContent = error.message; errorEl.classList.remove('hidden'); }
    else toast(error.message);
  }
});

function liveOrderStatusView(result) {
  const type = result.kind === 'immediate' ? '立即点菜' : result.kind === 'reservation' ? '仅预约' : '预约点单';
  const dishes = result.items.length ? result.items.map(item => `${item.dish_name} x${item.quantity}`).join('、') : '尚未选择菜品';
  return `<section class="live-order-status"><div><span>当前状态</span><strong>${result.status}</strong></div><span class="status ${result.status}">${result.status}</span><p>${type} · ${result.reservation.date} ${result.reservation.time_slot} · ${result.reservation.guests} 人</p><p>${escapeHtml(dishes)}</p><div class="form-actions"><button type="button" class="secondary" data-refresh-live-order>刷新状态</button></div></section>`;
}
async function refreshLiveOrderStatus() {
  const resultEl = document.querySelector('#live-order-result');
  const fields = state.liveOrderLookup;
  if (!resultEl || !fields) return;
  resultEl.innerHTML = '<p class="hint">正在刷新订单状态...</p>';
  try {
    const result = await api(`/api/lookup?code=${encodeURIComponent(fields.code)}&token=${encodeURIComponent(fields.token)}`);
    resultEl.innerHTML = liveOrderStatusView(result);
  } catch (error) { resultEl.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}
lookupPage = function() {
  return `<main class="page"><div class="narrow"><div class="section-heading"><div><h2>我的订单</h2><p>输入订单编号和查询凭证，查看当前处理状态。</p></div><button class="text-button" type="button" data-route="menu">返回点菜</button></div><form class="panel" id="live-order-lookup"><div class="form-grid"><div class="field"><label>订单编号</label><input name="code" required placeholder="例如 FT-A1B2C3"></div><div class="field"><label>查询凭证</label><input name="token" required placeholder="提交成功时获得"></div></div><p class="error hidden" id="live-order-error"></p><div class="form-actions"><button class="primary">查询订单</button></div></form><div id="live-order-result"></div></div></main>`;
};
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'live-order-lookup') return;
  event.preventDefault();
  const error = form.querySelector('#live-order-error');
  error.classList.add('hidden');
  state.liveOrderLookup = Object.fromEntries(new FormData(form));
  try {
    await refreshLiveOrderStatus();
    clearInterval(state.liveOrderRefreshTimer);
    state.liveOrderRefreshTimer = window.setInterval(() => {
      if (location.hash === '#lookup' && state.liveOrderLookup) refreshLiveOrderStatus();
    }, 15000);
  }
  catch (failure) { error.textContent = failure.message; error.classList.remove('hidden'); }
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-refresh-live-order]')) refreshLiveOrderStatus();
});
window.addEventListener('hashchange', () => {
  if (location.hash !== '#lookup') clearInterval(state.liveOrderRefreshTimer);
});
orderQuickActions = function(order) {
  if (order.status === '待确认') return `<button class="primary" data-order-action="confirm" data-order-id="${order.id}">确认</button><button class="danger" data-order-action="reject" data-order-id="${order.id}">拒绝</button>`;
  if (order.status === '已确认') return `<button class="primary" data-order-action="complete" data-order-id="${order.id}">标记完成</button>`;
  return '';
};
overviewOrderNeedsAction = function(order) { return ['待确认', '已确认'].includes(order.status); };
renderOrderAdminContent = async function(el) {
  const view = state.ordersView || 'orders';
  if (view === 'rules') {
    const settings = await api('/api/admin/settings');
    el.innerHTML = `<section class="order-workspace"><div class="order-workspace-head"><div><h2>订单与预约</h2><p>管理接单状态和访客可预约的规则。</p></div></div><nav class="settings-tabs order-section-tabs" aria-label="订单与预约页面"><button type="button" data-orders-view="orders">订单列表</button><button type="button" data-orders-view="rules" class="active">预约与营业</button></nav>${bookingSettingsView(settings)}</section>`;
    return;
  }
  const orders = await api('/api/admin/orders');
  state.orderAdminData = orders;
  const filters = state.orderAdminFilters;
  el.innerHTML = `<section class="order-workspace"><div class="order-workspace-head"><div><h2>订单与预约</h2><p>按状态、订单编号、联系人或菜品名称快速定位订单。</p></div><span class="order-total">共 ${orders.length} 条</span></div><nav class="settings-tabs order-section-tabs" aria-label="订单与预约页面"><button type="button" data-orders-view="orders" class="active">订单列表</button><button type="button" data-orders-view="rules">预约与营业</button></nav><section class="order-admin-main"><div class="order-admin-toolbar"><input type="search" data-order-admin-search value="${escapeHtml(filters.query)}" placeholder="搜索订单号、联系人或菜品" aria-label="搜索订单"><select data-order-admin-status aria-label="订单状态"><option value="all" ${filters.status === 'all' ? 'selected' : ''}>全部状态</option><option value="待确认" ${filters.status === '待确认' ? 'selected' : ''}>待处理</option><option value="已确认" ${filters.status === '已确认' ? 'selected' : ''}>已确认</option><option value="已完成" ${filters.status === '已完成' ? 'selected' : ''}>已完成</option><option value="已拒绝" ${filters.status === '已拒绝' ? 'selected' : ''}>已拒绝</option></select></div><div id="order-admin-table">${renderOrderAdminTable(orders)}</div></section></section>`;
};
todayMealsDrawer = function() {
  return `<div class="drawer-backdrop today-meals-backdrop" data-action="close-today-meals"><aside class="drawer today-meals-drawer"><div class="modal-head"><div><h2>最近订单</h2><p class="hint">这台设备最近提交的订单</p></div><button class="close" data-action="close-today-meals" aria-label="关闭">×</button></div><div id="today-meals-list" class="today-meals-list"><p class="hint">正在读取最近订单...</p></div></aside></div>`;
};
function recentOrderCard(record) {
  const label = record.kind === 'immediate' ? '立即点菜' : record.kind === 'reservation' ? '仅预约' : '预约点单';
  const timing = record.kind === 'immediate' ? '刚刚提交' : `${record.reservation.date} ${record.reservation.time_slot} · ${record.reservation.guests} 人`;
  const dishes = record.items.length ? record.items.map(item => `${escapeHtml(item.dish_name)} × ${item.quantity}`).join('、') : '尚未选择菜品';
  return `<article class="recent-order-card"><div><strong>${label}</strong><p>${escapeHtml(timing)}</p><p class="recent-order-dishes">${dishes}</p></div><span class="status ${record.status}">${record.status}</span></article>`;
}
loadTodayMeals = async function() {
  const target = document.querySelector('#today-meals-list');
  const records = savedRecords();
  if (!target) return;
  const resolved = await Promise.all(records.map(async record => { try { return await api(`/api/lookup?code=${encodeURIComponent(record.code)}&token=${encodeURIComponent(record.token)}`); } catch { return null; } }));
  if (!document.querySelector('#today-meals-list')) return;
  const recent = resolved.filter(Boolean).slice(0, 8);
  target.innerHTML = recent.length ? recent.map(recentOrderCard).join('') : '<div class="empty">还没有最近订单。</div>';
};
waitingPage = function() {
  return `<main class="page"><div class="waiting-shell"><section class="waiting-intro"><p class="eyebrow">订单已提交</p><h1>已发往厨房</h1><p>订单已提交，可在最近订单中查看处理状态。</p></section><section id="waiting-order" class="waiting-order"><p class="hint">正在读取订单内容...</p></section><div class="waiting-actions"><button class="secondary" data-action="open-today-meals">最近订单</button><button class="primary" data-route="menu">返回首页</button></div></div></main>`;
};
waitingOrderView = function(record) {
  const content = record.items.length ? mealItems(record.items) : '<p class="waiting-empty">当前订单仅预约了用餐时间。</p>';
  return `<header class="waiting-order-head"><div><p>订单内容</p><h2>已提交</h2></div><span class="status ${record.status}">${record.status}</span></header><section class="waiting-section">${content}</section>`;
};


adminContent = async function(dashboard) {
  const el = document.querySelector('#admin-content');
  if (state.adminTab === 'menu-transfer') return adminMenuTransfer(el);
  if (state.adminTab === 'about') { el.innerHTML = aboutProjectView(); loadUpdateInfo(); return; }
  if (state.adminTab === 'overview') {
    const settings = await api('/api/admin/settings');
    el.innerHTML = `${businessStatusBadge(settings)}<div class="stats"><div class="stat"><strong>${dashboard.pending}</strong><span>待确认</span></div><div class="stat"><strong>${dashboard.confirmed}</strong><span>已确认</span></div><div class="stat"><strong>${dashboard.today.length}</strong><span>今日订单</span></div></div><div class="section-heading"><div><h2>最近订单</h2><p>优先处理待确认预约。</p></div><button class="secondary" data-admin-tab="orders">查看全部</button></div>${orderCards(dashboard.recent)}`;
    return;
  }
  if (state.adminTab === 'orders') return renderOrderAdminContent(el);
  if (state.adminTab === 'reviews') return adminReviews(el);
  if (state.adminTab === 'images') return adminImages(el);
  if (state.adminTab === 'menu') return adminMenu(el);
  if (state.adminTab === 'settings') return adminSettings(el);
};
cartDrawer = function() {
  return `<div class="drawer-backdrop cart-popover-backdrop" data-action="close-cart"><aside class="drawer cart-popover" role="dialog" aria-label="已选菜品"><div class="modal-head"><div><h2>已选菜品</h2><p class="hint">共 ${cartCount()} 道</p></div><button class="close" data-action="close-cart" aria-label="关闭">×</button></div><div class="cart-items">${state.cart.map((item, index) => `<article class="cart-item"><div><h3>${escapeHtml(item.name)} × ${item.quantity}</h3><p class="cart-options">${escapeHtml(item.options.map(x => `${x.group}：${x.value}`).join('、') || '未选附加属性')}</p>${item.note ? `<p class="cart-options">备注：${escapeHtml(item.note)}</p>` : ''}</div><button class="remove" data-remove-cart="${index}">移除</button></article>`).join('')}</div></aside></div>`;
};
refreshCartDrawer = function() {
  const panel = document.querySelector('.cart-popover-backdrop');
  if (!state.cart.length) {
    panel?.remove();
    render();
    return;
  }
  document.querySelectorAll('.cart-bar-count').forEach(element => { element.textContent = cartCount(); });
  if (panel) {
    panel.insertAdjacentHTML('afterend', cartDrawer());
    panel.remove();
  }
};
publicFooter = function() { return ''; };
layout = function(content) {
  const now = new Date();
  return `<header class="topbar"><div class="public-brand-area">${brand()}<time class="live-clock" datetime="${now.toISOString()}" aria-label="当前日期和时间">${liveClockText(now)}</time></div><nav class="nav"><button class="order-button" data-action="open-today-meals">订单</button><button class="admin-entry" data-route="admin">后台管理</button></nav></header>${content}${cartBar()}`;
};
document.addEventListener('click', event => {
  const cartTrigger = event.target.closest('[data-action="open-cart"]');
  if (!cartTrigger) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const panel = document.querySelector('.cart-popover-backdrop');
  if (panel) panel.remove();
  else app.insertAdjacentHTML('beforeend', cartDrawer());
}, true);

function cartBar() {
  if (location.hash && location.hash !== '#menu' || !cartCount()) return '';
  return `<section class="cart-bar" aria-label="已选菜品"><button class="cart-summary-button" data-action="open-cart" aria-label="查看已选菜品" title="查看已选菜品"><span aria-hidden="true">&#128722;</span><b class="cart-bar-count">${cartCount()}</b></button><button class="cart-ready-button" data-route="checkout">选好了</button></section>`;
}
let categoryRailFrame = 0;
function updateMobileCategoryRail() {
  if (categoryRailFrame) return;
  categoryRailFrame = window.requestAnimationFrame(() => {
    categoryRailFrame = 0;
    const workspace = document.querySelector('.menu-workspace');
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    workspace.classList.toggle('category-rail-pinned', mobile && bounds.top <= 58 && bounds.bottom > 58);
    if (!mobile) return;
    const categories = [...workspace.querySelectorAll('.category[id]')];
    let currentCategory = categories[0];
    if (bounds.bottom <= window.innerHeight) currentCategory = categories[categories.length - 1];
    else categories.forEach(category => {
      if (category.getBoundingClientRect().top <= 130) currentCategory = category;
    });
    const currentId = currentCategory?.id.replace('menu-category-', '');
    workspace.querySelectorAll('[data-menu-category]').forEach(button => {
      button.classList.toggle('active', button.dataset.menuCategory === currentId);
    });
  });
}
window.addEventListener('scroll', updateMobileCategoryRail, { passive: true });
window.addEventListener('resize', updateMobileCategoryRail);
window.addEventListener('hashchange', updateMobileCategoryRail);

// ===== 前台：确认订单（checkout） =====
function checkoutDateChoices() {
  const limit = Math.min(Number(state.site?.schedule?.maxDays) || 7, 7);
  return Array.from({ length: limit }, (_, index) => dateValue(index));
}
function checkoutDateLabel(date) {
  const value = new Date(`${date}T00:00:00`);
  const today = dateValue(0);
  if (date === today) return '今天';
  if (date === dateValue(1)) return '明天';
  return `${value.getMonth() + 1}月${value.getDate()}日`;
}
function checkoutTimingLabel() {
  const timing = state.checkoutTiming;
  return timing ? `${checkoutDateLabel(timing.date)} ${timing.timeSlot}` : '马上点菜';
}
function checkoutDishImage(item) {
  return item.imageUrl || state.menu.flatMap(category => category.dishes).find(dish => dish.name === item.name)?.imageUrl || '';
}
function checkoutItems() {
  return state.cart.map(item => `<article class="checkout-item"><img src="${image(checkoutDishImage(item))}" alt="${escapeHtml(item.name)}"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.options.map(option => `${option.group}：${option.value}`).join('、') || '未选附加属性')}</p>${item.note ? `<p>备注：${escapeHtml(item.note)}</p>` : ''}<span>× ${item.quantity}</span></div></article>`).join('');
}
function checkoutPage() {
  return `<main class="page checkout-page"><div class="checkout-shell"><header class="checkout-head"><h1>确认订单</h1><p>确认信息后发送到厨房。</p></header><form id="checkout-form"><button class="checkout-arrival" type="button" data-action="open-checkout-time-picker"><span>到店时间</span><strong id="checkout-timing-value">${checkoutTimingLabel()}</strong><i aria-hidden="true">›</i></button><section class="checkout-fields"><label><span>下单人 <b>*</b></span><input name="contactName" maxlength="50" required placeholder="怎么称呼您"></label><label><span>联系方式 <em>选填</em></span><input name="contactInfo" maxlength="100" placeholder="手机号或微信号"></label><label><span>备注 <em>选填</em></span><textarea name="note" maxlength="300" placeholder="例如：菜品统一少盐；请尽快确认"></textarea></label></section><p class="checkout-error hidden" id="checkout-error"></p><section class="checkout-items"><header><h2>已点菜品</h2><span>共 ${cartCount()} 道</span></header>${checkoutItems()}</section></form></div></main><footer class="checkout-submit-bar"><span>已选 ${cartCount()} 道</span><button class="primary" form="checkout-form">确认下单</button></footer>`;
}
function checkoutTimePicker() {
  const selected = state.checkoutPickerDate || dateValue(0);
  return `<div class="checkout-time-backdrop" data-action="close-checkout-time-picker"><section class="checkout-time-sheet" role="dialog" aria-modal="true" aria-labelledby="checkout-time-title"><header><h2 id="checkout-time-title">选择到店时间</h2><button class="close" type="button" data-action="close-checkout-time-picker" aria-label="关闭">×</button></header><div class="checkout-time-picker-body"><nav class="checkout-date-list" aria-label="选择日期">${checkoutDateChoices().map(date => `<button type="button" class="${date === selected ? 'active' : ''}" data-checkout-date="${date}"><strong>${checkoutDateLabel(date)}</strong><span>${new Date(`${date}T00:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' })}</span></button>`).join('')}</nav><div class="checkout-time-list" id="checkout-time-list"><p class="hint">正在读取可用时段...</p></div></div></section></div>`;
}
async function renderCheckoutTimes() {
  const target = document.querySelector('#checkout-time-list');
  const date = state.checkoutPickerDate || dateValue(0);
  if (!target) return;
  try {
    const availability = await api(`/api/availability?date=${encodeURIComponent(date)}`);
    const immediate = date === dateValue(0) ? '<button type="button" class="checkout-time-option immediate" data-checkout-immediate>马上点菜</button>' : '';
    const slots = availability.slots.filter(slot => slot.available).map(slot => `<button type="button" class="checkout-time-option" data-checkout-time="${slot.time}">${slot.time}</button>`).join('');
    target.innerHTML = immediate + (slots || '<p class="hint">当天没有可预约的时段。</p>');
  } catch (error) {
    target.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}
function openCheckoutTimePicker() {
  state.checkoutPickerDate = state.checkoutTiming?.date || dateValue(0);
  document.querySelector('.checkout-time-backdrop')?.remove();
  app.insertAdjacentHTML('beforeend', checkoutTimePicker());
  renderCheckoutTimes();
}
function closeCheckoutTimePicker() {
  document.querySelector('.checkout-time-backdrop')?.remove();
}
function refreshCheckoutTiming() {
  const target = document.querySelector('#checkout-timing-value');
  if (target) target.textContent = checkoutTimingLabel();
}
function mountCheckoutHeaderControls() {
  const header = document.querySelector('.checkout-head');
  if (!header || header.dataset.controlsMounted) return;
  header.dataset.controlsMounted = 'true';

  const continueButton = document.createElement('button');
  continueButton.type = 'button';
  continueButton.className = 'checkout-continue-button';
  continueButton.dataset.route = 'menu';
  continueButton.textContent = '继续点菜';
  header.append(continueButton);

  const arrow = document.querySelector('.checkout-arrival i');
  if (arrow) arrow.textContent = '';
}
document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'open-checkout-time-picker') { openCheckoutTimePicker(); return; }
  if (event.target.closest('button[data-action="close-checkout-time-picker"]') || event.target.matches('.checkout-time-backdrop')) { closeCheckoutTimePicker(); return; }
  const dateButton = event.target.closest('[data-checkout-date]');
  if (dateButton) {
    state.checkoutPickerDate = dateButton.dataset.checkoutDate;
    document.querySelectorAll('[data-checkout-date]').forEach(button => button.classList.toggle('active', button === dateButton));
    renderCheckoutTimes();
    return;
  }
  if (event.target.closest('[data-checkout-immediate]')) {
    state.checkoutTiming = null;
    closeCheckoutTimePicker();
    refreshCheckoutTiming();
    return;
  }
  const timeButton = event.target.closest('[data-checkout-time]');
  if (timeButton) {
    state.checkoutTiming = { date: state.checkoutPickerDate || dateValue(0), timeSlot: timeButton.dataset.checkoutTime };
    closeCheckoutTimePicker();
    refreshCheckoutTiming();
  }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'checkout-form') return;
  event.preventDefault();
  const error = document.querySelector('#checkout-error');
  error.classList.add('hidden');
  try {
    const fields = Object.fromEntries(new FormData(form));
    if (!String(fields.contactName || '').trim()) throw new Error('请填写下单人');
    if (!form.dataset.requestId) form.dataset.requestId = newRequestId();
    const requestId = form.dataset.requestId;
    const timing = state.checkoutTiming;
    const result = await api(timing ? '/api/order' : '/api/immediate-order', { method: 'POST', body: JSON.stringify({ ...fields, date: timing?.date, timeSlot: timing?.timeSlot, guests: 1, items: state.cart, requestId }) });
    form.dataset.requestId = '';
    state.cart = [];
    saveCart();
    showBookingSuccess(result);
  } catch (failure) {
    error.textContent = failure.message;
    error.classList.remove('hidden');
  }
});

// ===== 前台：菜品详情与规格弹窗 =====
function dishOptionGroupsMarkup(dish) {
  return dish.options.map((group, index) => `<section class="option-group" data-group="${index}" data-type="${group.type}"><div class="option-head"><span>${escapeHtml(group.name)}</span>${group.required ? '<span class="required">必选</span>' : ''}</div><div class="chips">${group.values.map((value, valueIndex) => `<button type="button" class="chip ${valueIndex === 0 && group.required ? 'selected' : ''}" data-option="${index}" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('')}</div></section>`).join('');
}
function dishReviewFormMarkup(dish) {
  return `<form id="review-form" data-dish-id="${dish.id}" class="review-form"><div class="review-form-head"><strong>写评价</strong><div class="review-rating" aria-label="评分">${[1, 2, 3, 4, 5].map(value => `<button type="button" class="review-star ${value <= state.reviewRating ? 'selected' : ''}" data-review-rating="${value}" title="${value} 星" aria-label="${value} 星">★</button>`).join('')}</div></div><div class="field"><label>怎么称呼您？</label><input name="author" maxlength="30" placeholder="不填则显示为匿名"></div><div class="field"><label>想说点什么？</label><textarea name="content" maxlength="300" required placeholder="例如：辣度正好，希望下次汤汁多一点"></textarea></div><p class="error hidden" id="review-error"></p><div class="form-actions"><button class="secondary" type="submit">提交评价</button></div></form>`;
}
function dishDetailModal() {
  const dish = state.selected;
  if (!dish) return '';
  const optionNames = dish.options.map(group => group.name).join('、') || '无需选规格';
  return `<div class="modal-backdrop" data-action="close-dish"><section class="modal dish-modal dish-detail-modal" role="dialog" aria-modal="true" aria-labelledby="dish-detail-title"><div class="dish-modal-media"><img src="${image(dish.imageUrl)}" alt="${escapeHtml(dish.name)}"><button class="close dish-modal-close" type="button" data-action="close-dish" aria-label="关闭">×</button></div><div class="dish-detail-content"><section class="dish-detail-summary"><div><h2 id="dish-detail-title">${escapeHtml(dish.name)}</h2><p>${escapeHtml(optionNames)}</p></div><button class="primary dish-spec-trigger" type="button" data-action="open-dish-specs">选规格</button></section><section class="dish-detail-description"><h3>菜品简介</h3><p>${escapeHtml(dish.description)}</p></section><section class="dish-review-card"><header><h3>评价</h3><button class="dish-review-all" type="button" data-action="show-dish-reviews">查看全部</button></header><div id="dish-review-preview"><p class="hint">正在读取评价...</p></div></section></div></section></div>`;
}
function dishSpecsModal() {
  const dish = state.selected;
  if (!dish) return '';
  return `<div class="dish-spec-backdrop" data-action="close-dish-specs"><section class="dish-spec-sheet" role="dialog" aria-modal="true" aria-labelledby="dish-spec-title"><header><h2 id="dish-spec-title">${escapeHtml(dish.name)}</h2><button class="close" type="button" data-action="close-dish-specs" aria-label="关闭">×</button></header><form id="dish-form" data-dish-id="${dish.id}" class="dish-spec-form"><div class="dish-spec-options">${dishOptionGroupsMarkup(dish)}<div class="field dish-note-field"><label>菜品备注</label><input name="note" maxlength="150" placeholder="例如：不要葱"></div><div class="qty-row"><strong>数量</strong><div class="stepper"><button type="button" data-action="minus">−</button><span id="dish-qty">1</span><button type="button" data-action="plus">+</button></div></div><p class="error hidden" id="dish-error"></p></div><footer class="dish-spec-footer"><p id="dish-spec-selection"></p><button type="submit" class="primary">加入已选</button></footer></form></section></div>`;
}
function updateDishSpecSelection(form) {
  const target = form?.querySelector('#dish-spec-selection');
  if (!target) return;
  const selected = [...form.querySelectorAll('.option-group')].flatMap(group => [...group.querySelectorAll('.chip.selected')].map(chip => `${group.querySelector('.option-head > span')?.textContent}：${chip.dataset.value}`));
  target.textContent = selected.length ? `已选规格：${selected.join('、')}` : '请选择规格';
}
function reviewPreviewMarkup(data) {
  if (!data.count || !data.reviews.length) return '<p class="dish-review-empty">暂时还没有评价，尝过后留下第一条吧。</p>';
  const review = data.reviews[0];
  const date = new Date(review.created_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return `<article class="dish-review-preview-item"><div><strong>${escapeHtml(review.author)}</strong><span>${reviewStars(review.rating)}</span><time>${date}</time></div><p>${escapeHtml(review.content)}</p></article>`;
}
async function loadDishReviewPreview(dishId) {
  const target = document.querySelector('#dish-review-preview');
  if (!target) return;
  try {
    target.innerHTML = reviewPreviewMarkup(await api(`/api/dishes/${dishId}/reviews`));
  } catch (error) {
    target.innerHTML = '<p class="dish-review-empty">暂时无法读取评价。</p>';
  }
}
function mountDishDetailPreview() {
  const preview = document.querySelector('#dish-review-preview');
  if (preview && !preview.dataset.loaded && state.selected) {
    preview.dataset.loaded = 'true';
    loadDishReviewPreview(state.selected.id);
  }
}
function dishReviewsModal() {
  const dish = state.selected;
  if (!dish) return '';
  return `<div class="dish-reviews-backdrop"><section class="dish-reviews-sheet" role="dialog" aria-modal="true" aria-labelledby="dish-reviews-title"><header><div><h2 id="dish-reviews-title">全部评价</h2><p>${escapeHtml(dish.name)}</p></div><button class="close" type="button" data-action="close-dish-reviews" aria-label="关闭">×</button></header><div class="dish-reviews-body"><section id="dish-review-summary" class="dish-reviews-summary"><p class="hint">正在读取评分...</p></section><section id="dish-review-list"><p class="hint">正在读取评价...</p></section></div><footer class="dish-reviews-footer"><button class="primary" type="button" data-action="open-dish-review-form">发表评价</button></footer></section></div>`;
}
function dishReviewComposerModal() {
  const dish = state.selected;
  if (!dish) return '';
  return `<div class="dish-review-compose-backdrop"><section class="dish-review-compose-sheet" role="dialog" aria-modal="true" aria-labelledby="dish-review-compose-title"><header><h2 id="dish-review-compose-title">发表评价</h2><button class="close" type="button" data-action="close-dish-review-form" aria-label="关闭">×</button></header><div>${dishReviewFormMarkup(dish)}</div></section></div>`;
}
async function loadDishReviewsSheet(dishId) {
  const summary = document.querySelector('#dish-review-summary');
  const list = document.querySelector('#dish-review-list');
  if (!summary || !list) return;
  try {
    const data = await api(`/api/dishes/${dishId}/reviews`);
    summary.innerHTML = data.count ? `<strong>${Number(data.average).toFixed(1)}</strong><div><span>${reviewStars(data.average)}</span><p>${data.count} 条评价</p></div>` : '<strong>暂无评分</strong><div><span>还没有评价</span><p>尝过后留下第一条吧。</p></div>';
    list.innerHTML = data.reviews.length ? `<div class="review-list">${data.reviews.map(reviewMarkup).join('')}</div>` : '<p class="dish-review-empty">暂时还没有评价，尝过后留下第一条吧。</p>';
  } catch (error) {
    summary.innerHTML = '';
    list.innerHTML = '<p class="dish-review-empty">暂时无法读取评价。</p>';
  }
}
modal = dishDetailModal;
function closeDishSurface(overlay) {
  if (!overlay || overlay.classList.contains('is-closing')) return;
  overlay.classList.add('is-closing');
  window.setTimeout(() => overlay.remove(), 220);
}
document.addEventListener('click', event => {
  const option = event.target.closest('.dish-spec-sheet [data-option]');
  if (!option) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const group = option.closest('.option-group');
  if (group?.dataset.type === 'single') group.querySelectorAll('.chip').forEach(chip => chip.classList.remove('selected'));
  option.classList.toggle('selected');
  updateDishSpecSelection(option.closest('#dish-form'));
}, true);
document.addEventListener('click', event => {
  const sheet = event.target.closest('.dish-spec-sheet');
  if (!sheet) return;
  const action = event.target.closest('.dish-spec-sheet [data-action]')?.dataset.action;
  if (action === 'close-dish-specs') closeDishSurface(document.querySelector('.dish-spec-backdrop'));
  if (action === 'plus' || action === 'minus') {
    const quantity = sheet.querySelector('#dish-qty');
    if (quantity) quantity.textContent = Math.max(1, Number(quantity.textContent) + (action === 'plus' ? 1 : -1));
  }
  event.stopPropagation();
}, true);
document.addEventListener('click', event => {
  const openSpecs = event.target.closest('[data-action="open-dish-specs"]');
  if (openSpecs) {
    document.querySelector('.dish-spec-backdrop')?.remove();
    app.insertAdjacentHTML('beforeend', dishSpecsModal());
    updateDishSpecSelection(document.querySelector('#dish-form'));
    return;
  }

  const closeSpecs = event.target.closest('[data-action="close-dish-specs"]');
  if (closeSpecs) {
    closeDishSurface(document.querySelector('.dish-spec-backdrop'));
    return;
  }

  const allReviews = event.target.closest('[data-action="show-dish-reviews"]');
  if (allReviews && state.selected) {
    state.reviewsExpanded = true;
    document.querySelector('.dish-reviews-backdrop')?.remove();
    app.insertAdjacentHTML('beforeend', dishReviewsModal());
    loadDishReviewsSheet(state.selected.id);
    return;
  }

  if (event.target.closest('[data-action="close-dish-reviews"]') || event.target.matches('.dish-reviews-backdrop')) {
    closeDishSurface(document.querySelector('.dish-reviews-backdrop'));
    return;
  }

  if (event.target.closest('[data-action="open-dish-review-form"]')) {
    document.querySelector('.dish-review-compose-backdrop')?.remove();
    app.insertAdjacentHTML('beforeend', dishReviewComposerModal());
    return;
  }

  if (event.target.closest('[data-action="close-dish-review-form"]') || event.target.matches('.dish-review-compose-backdrop')) {
    closeDishSurface(document.querySelector('.dish-review-compose-backdrop'));
    return;
  }

  const option = event.target.closest('.dish-spec-sheet [data-option]');
  if (option) updateDishSpecSelection(option.closest('#dish-form'));
});
loadDishReviews = async function(dishId) {
  if (!state.reviewsExpanded) return;
  if (document.querySelector('#dish-review-list')) {
    closeDishSurface(document.querySelector('.dish-review-compose-backdrop'));
    return loadDishReviewsSheet(dishId);
  }
  const detailTarget = document.querySelector('#dish-review-full-list');
  if (detailTarget) {
    try {
      const data = await api(`/api/dishes/${dishId}/reviews`);
      detailTarget.innerHTML = data.reviews.length ? `<div class="review-list">${data.reviews.map(reviewMarkup).join('')}</div>` : '<p class="dish-review-empty">暂时还没有评价，尝过后留下第一条吧。</p>';
    } catch (error) {
      detailTarget.innerHTML = '<p class="dish-review-empty">暂时无法读取评价。</p>';
    }
    return;
  }
  const target = document.querySelector('#dish-reviews-content');
  if (!target) return;
  try {
    const data = await api(`/api/dishes/${dishId}/reviews`);
    const summary = data.count ? `<strong>${data.average}</strong><span>${reviewStars(data.average)} · ${data.count} 条点评</span>` : '<strong>暂无评分</strong><span>第一条点评由你来写</span>';
    target.innerHTML = `<div class="review-summary">${summary}</div><div class="review-list">${data.reviews.length ? data.reviews.map(reviewMarkup).join('') : '<p class="hint">还没有点评，尝尝后留下建议吧。</p>'}</div>`;
  } catch (error) {
    target.innerHTML = `<p class="hint">暂时无法读取点评：${escapeHtml(error.message)}</p>`;
  }
};
// ===== 前台：首页 hero 与每日一言 =====
function heroQuoteMarkup() {
  if (!state.heroQuote) return '<p class="hero-quote-loading">正在准备今天的话...</p>';
  const quoteLength = Array.from(state.heroQuote.text).length;
  const quoteSize = quoteLength > 80 ? 'is-extra-long' : quoteLength > 52 ? 'is-long' : quoteLength > 34 ? 'is-medium' : 'is-standard';
  return `<blockquote class="hero-quote-text ${quoteSize}"><span class="hero-quote-inline-mark">“</span>${escapeHtml(state.heroQuote.text)}<span class="hero-quote-inline-mark">”</span></blockquote><p class="hero-quote-source">${escapeHtml(state.heroQuote.source)}</p>`;
}
function heroStatusMarkup(categories = []) {
  const open = Boolean(state.site?.siteOpen);
  const dishCount = categories.reduce((total, category) => total + category.dishes.length, 0);
  return `<aside class="hero-status ${open ? 'is-open' : 'is-closed'}"><section class="hero-status-current"><span>今日状态</span><strong>${open ? '营业中' : '暂停接单'}</strong><p>${open ? '现在可以选菜并提交订单。' : '暂不接受新的点单和预约。'}</p></section><section class="hero-menu-outline"><span>当前菜单</span><strong><b>${categories.length}</b><small>个分类</small><i></i><b>${dishCount}</b><small>道菜</small></strong></section></aside>`;
}
async function loadHeroQuote() {
  if (state.heroQuoteLoading) return;
  state.heroQuoteLoading = true;
  try {
    state.heroQuote = await api('/api/daily-quote', { cache: 'no-store' });
    const target = document.querySelector('.hero-quote');
    if (target) target.innerHTML = heroQuoteMarkup();
  } catch {
    state.heroQuote = { text: '愿每一顿饭，都能让忙碌的人慢下来。', source: '家宴点单' };
  } finally {
    state.heroQuoteLoading = false;
  }
}
function mountHeroQuote() {
  if (location.hash && location.hash !== '#menu') return;
  const target = document.querySelector('.hero-quote');
  if (!target) return;
  state.heroQuote = null;
  target.innerHTML = heroQuoteMarkup();
  loadHeroQuote();
}
menuPage = function() {
  const categories = state.menu.filter(category => category.dishes.length);
  return `<main class="page"><section class="hero hero-information"><div class="hero-information-main"><p class="eyebrow">FAMILY TABLE</p><h1>${escapeHtml(state.site.title)}</h1><div class="hero-mobile-intro"><p>今日家宴</p><h2>今天吃什么？</h2><span>${escapeHtml(state.site.welcome)}</span></div><div class="hero-illustration-slot" aria-hidden="true"><img src="/assets/home-hero-illustration.png" alt=""></div><div class="hero-quote">${heroQuoteMarkup()}</div></div>${heroStatusMarkup(categories)}</section><div class="menu-workspace" id="menu-list"><aside class="category-rail" aria-label="菜单分类"><p class="category-rail-title">菜单分类</p><div class="category-rail-list">${categories.map((category, index) => `<button class="category-rail-button ${index === 0 ? 'active' : ''}" data-menu-category="${category.id}"><span>${escapeHtml(category.name)}</span><b>${category.dishes.length}</b></button>`).join('')}</div></aside><div class="menu-content"><div class="section-heading"><div><h2>今日菜单</h2><p>点进菜品后再选择规格、数量和备注。</p></div></div>${categories.map(category => `<section class="category" id="menu-category-${category.id}"><h3 class="category-title">${escapeHtml(category.name)} <span>${category.dishes.length} 道</span></h3><div class="dish-grid">${category.dishes.map(dish => `<button class="dish-card" data-dish="${dish.id}" aria-label="选择${escapeHtml(dish.name)}"><img class="dish-image" src="${image(dish.imageUrl)}" alt="${escapeHtml(dish.name)}">${dishCardStats(dish)}<div class="dish-body"><h3 class="dish-name">${escapeHtml(dish.name)}</h3><p class="dish-desc">${escapeHtml(dish.description)}</p></div></button>`).join('')}</div></section>`).join('')}</div></div></main>`;
};

document.addEventListener('click', event => {
  if (event.target.closest('[data-dish]')) state.reviewsExpanded = false;
}, true);

render = function() {
  const afterRender = () => {
    mountDishReviewDisclosure();
    mountCheckoutHeaderControls();
    mountDishDetailPreview();
    mountHeroQuote();
    updateMobileCategoryRail();
  };
  if (location.hash === '#checkout') {
    if (!state.cart.length) { location.hash = 'menu'; return; }
    appRoot(checkoutPage());
    afterRender();
    return;
  }
  if (location.hash === '#reserve') { location.hash = 'menu'; return; }
  const route = location.hash.slice(1) || 'menu';
  if (route === 'quick-order') { appRoot(state.cart.length ? bookingForm('immediate') : menuPage()); afterRender(); return; }
  if (route === 'waiting') { appRoot(waitingPage()); loadWaitingOrder(); afterRender(); return; }
  if (route === 'my-records') { appRoot(myRecordsPage()); loadMyRecords(); afterRender(); return; }
  if (route === 'lookup') { appRoot(lookupPage()); afterRender(); return; }
  if (route === 'admin') { renderAdmin(); afterRender(); return; }
  appRoot(menuPage());
  afterRender();
};
adminPage = async function() {
  const data = await api('/api/admin/dashboard');
  const moreActive = ['reviews', 'images', 'settings', 'menu-transfer', 'about'].includes(state.adminTab);
  app.innerHTML = adminLayout(`<main class="page"><section class="admin-shell"><div class="admin-top"><div><h1 style="font-size:25px;margin:0">后台管理</h1><p class="hint">处理预约、维护菜单和站点信息。</p></div><div class="admin-top-actions"><button class="text-button" data-action="logout">退出登录</button></div></div><nav class="admin-tabs" role="tablist" aria-label="后台功能"><button role="tab" id="admin-tab-overview" aria-controls="admin-content" data-admin-tab="overview" class="${state.adminTab === 'overview' ? 'active' : ''}">🏠 概览</button><button role="tab" id="admin-tab-orders" aria-controls="admin-content" data-admin-tab="orders" class="${state.adminTab === 'orders' ? 'active' : ''}">📋 订单与预约</button><button role="tab" id="admin-tab-menu" aria-controls="admin-content" data-admin-tab="menu" class="${state.adminTab === 'menu' ? 'active' : ''}">🍽 菜单管理</button><button role="tab" id="admin-tab-reviews" aria-controls="admin-content" data-admin-tab="reviews" class="${state.adminTab === 'reviews' ? 'active' : ''}">⭐ 点评管理</button><button role="tab" id="admin-tab-images" aria-controls="admin-content" data-admin-tab="images" class="${state.adminTab === 'images' ? 'active' : ''}">🖼 图片管理</button><button role="tab" id="admin-tab-settings" aria-controls="admin-content" data-admin-tab="settings" class="${state.adminTab === 'settings' ? 'active' : ''}">⚙ 站点设置</button><button role="tab" id="admin-tab-about" aria-controls="admin-content" data-admin-tab="about" class="${state.adminTab === 'about' ? 'active' : ''}">ℹ 关于项目</button></nav><nav class="admin-bottom-bar" role="tablist" aria-label="后台导航"><button type="button" role="tab" id="admin-tabbar-overview" aria-controls="admin-content" class="admin-bottom-item ${state.adminTab === 'overview' ? 'active' : ''}" data-admin-tab="overview"><span aria-hidden="true">🏠</span>概览</button><button type="button" role="tab" id="admin-tabbar-orders" aria-controls="admin-content" class="admin-bottom-item ${state.adminTab === 'orders' ? 'active' : ''}" data-admin-tab="orders"><span aria-hidden="true">📋</span>订单</button><button type="button" role="tab" id="admin-tabbar-menu" aria-controls="admin-content" class="admin-bottom-item ${state.adminTab === 'menu' ? 'active' : ''}" data-admin-tab="menu"><span aria-hidden="true">🍽</span>菜单</button><button type="button" role="tab" class="admin-bottom-item admin-more-toggle ${moreActive ? 'active' : ''}" data-action="toggle-admin-more"><span aria-hidden="true">☰</span>更多</button></nav><nav class="admin-more-drawer" role="tablist" aria-label="更多后台功能"><button type="button" role="tab" data-admin-tab="reviews" class="${state.adminTab === 'reviews' ? 'active' : ''}">⭐ 点评管理</button><button type="button" role="tab" data-admin-tab="images" class="${state.adminTab === 'images' ? 'active' : ''}">🖼 图片管理</button><button type="button" role="tab" data-admin-tab="settings" class="${state.adminTab === 'settings' ? 'active' : ''}">⚙ 站点设置</button><button type="button" role="tab" data-admin-tab="menu-transfer" class="${state.adminTab === 'menu-transfer' ? 'active' : ''}">📦 菜单导入导出</button><button type="button" role="tab" data-admin-tab="about" class="${state.adminTab === 'about' ? 'active' : ''}">ℹ 关于项目</button></nav><div id="admin-content" role="tabpanel"></div></section><div class="admin-more-backdrop" data-action="close-admin-more" hidden></div></main>`);
  adminContent(data);
  const content = document.querySelector('#admin-content');
  if (content) {
    const playEntrance = () => {
      if (!content.firstElementChild) return;
      observer.disconnect();
      content.classList.remove('is-entering');
      window.requestAnimationFrame(() => content.classList.add('is-entering'));
    };
    const observer = new MutationObserver(playEntrance);
    observer.observe(content, { childList: true });
    playEntrance();
  }
  const settingsTab = document.querySelector('[data-admin-tab="settings"]');
  if (settingsTab && !document.querySelector('[data-admin-tab="menu-transfer"]')) settingsTab.insertAdjacentHTML('afterend', `<button role="tab" data-admin-tab="menu-transfer" aria-controls="admin-content" class="${state.adminTab === 'menu-transfer' ? 'active' : ''}">📦 菜单导入导出</button>`);
  syncAdminNav();
};
// ===== 启动 =====
boot();
