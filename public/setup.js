const form = document.querySelector('#setup-form');
const error = document.querySelector('#setup-error');

async function setupRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试');
  return data;
}

async function checkSetupStatus() {
  try {
    const status = await setupRequest('/api/setup');
    if (status.complete) location.replace('/');
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.hidden = true;
  const fields = Object.fromEntries(new FormData(form));
  if (fields.password !== fields.confirmPassword) {
    error.textContent = '两次输入的密码不一致';
    error.hidden = false;
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = '正在完成设置...';
  try {
    await setupRequest('/api/setup', { method: 'POST', body: JSON.stringify(fields) });
    location.replace('/');
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    submit.disabled = false;
    submit.textContent = '完成初始化';
  }
});

checkSetupStatus();
