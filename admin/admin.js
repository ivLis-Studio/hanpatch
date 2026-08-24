(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    dashboard: $("#dashboard"), disabledCount: $("#disabled-count"), empty: $("#empty-state"),
    enabledCount: $("#enabled-count"), list: $("#patcher-list"), loginError: $("#login-error"),
    loginForm: $("#login-form"), loginPanel: $("#login-panel"), logout: $("#logout-button"),
    input: $("#package-input"), progress: $("#upload-progress"), progressBar: $("#upload-bar"),
    progressName: $("#upload-name"), progressPercent: $("#upload-percent"), progressStatus: $("#upload-status"),
    refresh: $("#refresh-button"), toast: $("#toast"), token: $("#token-input"), totalCount: $("#total-count"),
    uploadZone: $("#upload-zone"),
  };
  let adminToken = sessionStorage.getItem("psp-patcher-admin-token") ?? "";
  let toastTimer = null;

  function formatBytes(value) {
    const units = ["B", "KB", "MB", "GB"];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${amount.toFixed(unit && amount < 100 ? 1 : 0)} ${units[unit]}`;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4000);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Authorization": `Bearer ${adminToken}`, ...(options.headers ?? {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message ?? `요청 실패: HTTP ${response.status}`);
      error.status = response.status;
      error.code = data.error;
      throw error;
    }
    return data;
  }

  function button(label, className, action) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", action);
    return node;
  }

  function renderPatchers(patchers) {
    elements.list.replaceChildren();
    elements.totalCount.textContent = String(patchers.length);
    elements.enabledCount.textContent = String(patchers.filter((item) => item.enabled).length);
    elements.disabledCount.textContent = String(patchers.filter((item) => !item.enabled).length);
    elements.empty.hidden = patchers.length !== 0;
    for (const patcher of patchers) {
      const article = document.createElement("article");
      article.className = "patcher-item";
      const info = document.createElement("div");
      const titleRow = document.createElement("div");
      titleRow.className = "patcher-title-row";
      const title = document.createElement("h3");
      title.textContent = patcher.title;
      const badge = document.createElement("span");
      badge.className = `status-badge ${patcher.enabled ? "is-enabled" : "is-disabled"}`;
      badge.textContent = patcher.enabled ? "공개 중" : "비공개";
      titleRow.append(title, badge);
      const meta = document.createElement("div");
      meta.className = "patcher-meta";
      for (const value of [`/${patcher.slug}/`, `v${patcher.version}`, patcher.input.discId, formatBytes(patcher.patch.size)]) {
        const span = document.createElement("span"); span.textContent = value; meta.append(span);
      }
      info.append(titleRow, meta);

      const actions = document.createElement("div");
      actions.className = "patcher-actions";
      actions.append(
        button(patcher.enabled ? "비공개" : "공개", "mini-button", async (event) => {
          event.currentTarget.disabled = true;
          try {
            await api(`/api/admin/patchers/${patcher.slug}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !patcher.enabled }),
            });
            showToast(`${patcher.title}을(를) ${patcher.enabled ? "비공개" : "공개"}로 변경했습니다.`);
            await loadPatchers();
          } catch (error) { showToast(error.message); event.currentTarget.disabled = false; }
        }),
        button("주소 복사", "mini-button", async () => {
          await navigator.clipboard.writeText(new URL(patcher.url, location.origin).href);
          showToast("패처 주소를 복사했습니다.");
        }),
        button("삭제", "danger-button", async (event) => {
          if (!confirm(`${patcher.title}을(를) 목록에서 삭제할까요?\n서버에서는 복구 가능한 휴지통으로 이동합니다.`)) return;
          event.currentTarget.disabled = true;
          try {
            await api(`/api/admin/patchers/${patcher.slug}`, { method: "DELETE" });
            showToast("패처를 서버 휴지통으로 이동했습니다.");
            await loadPatchers();
          } catch (error) { showToast(error.message); event.currentTarget.disabled = false; }
        }),
      );
      article.append(info, actions);
      elements.list.append(article);
    }
  }

  async function loadPatchers() {
    const data = await api("/api/admin/patchers");
    renderPatchers(data.patchers);
  }

  async function authenticate(token) {
    adminToken = token;
    await api("/api/admin/session");
    sessionStorage.setItem("psp-patcher-admin-token", token);
    elements.loginPanel.hidden = true;
    elements.dashboard.hidden = false;
    elements.logout.hidden = false;
    await loadPatchers();
  }

  function uploadRequest(file, replace = false) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `/api/admin/packages${replace ? "?replace=1" : ""}`);
      request.setRequestHeader("Authorization", `Bearer ${adminToken}`);
      request.setRequestHeader("Content-Type", "application/zip");
      request.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        elements.progressPercent.textContent = `${percent}%`;
        elements.progressBar.style.width = `${percent}%`;
        elements.progressBar.parentElement.setAttribute("aria-valuenow", String(percent));
        if (percent === 100) elements.progressStatus.textContent = "ZIP 구조와 패치 해시를 검증하고 있습니다.";
      });
      request.addEventListener("load", () => {
        const data = (() => { try { return JSON.parse(request.responseText); } catch { return {}; } })();
        if (request.status >= 200 && request.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.message ?? `업로드 실패: HTTP ${request.status}`), { status: request.status, code: data.error }));
      });
      request.addEventListener("error", () => reject(new Error("ZIP 업로드 중 네트워크 오류가 발생했습니다.")));
      request.send(file);
    });
  }

  async function upload(file) {
    if (!file || !file.name.toLowerCase().endsWith(".zip")) { showToast("ZIP 파일을 선택하세요."); return; }
    elements.uploadZone.hidden = true;
    elements.progress.hidden = false;
    elements.progressName.textContent = file.name;
    elements.progressPercent.textContent = "0%";
    elements.progressBar.style.width = "0";
    elements.progressStatus.textContent = "서버로 전송하고 있습니다.";
    try {
      try {
        await uploadRequest(file);
      } catch (error) {
        if (error.status !== 409 || !confirm("같은 주소의 패처가 이미 있습니다. 기존 버전을 교체할까요?\n이전 버전은 서버 휴지통에 보관됩니다.")) throw error;
        elements.progressStatus.textContent = "기존 패처를 안전하게 교체하고 있습니다.";
        await uploadRequest(file, true);
      }
      showToast("패치 패키지를 등록했습니다.");
      await loadPatchers();
    } catch (error) {
      showToast(error.message);
    } finally {
      elements.input.value = "";
      elements.uploadZone.hidden = false;
      elements.progress.hidden = true;
    }
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.loginError.hidden = true;
    try { await authenticate(elements.token.value); }
    catch (error) { elements.loginError.textContent = error.message; elements.loginError.hidden = false; }
  });
  elements.logout.addEventListener("click", () => { sessionStorage.removeItem("psp-patcher-admin-token"); location.reload(); });
  elements.refresh.addEventListener("click", async () => { try { await loadPatchers(); showToast("목록을 새로고침했습니다."); } catch (error) { showToast(error.message); } });
  elements.uploadZone.addEventListener("click", () => elements.input.click());
  elements.uploadZone.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); elements.input.click(); } });
  elements.input.addEventListener("change", () => upload(elements.input.files[0]));
  for (const type of ["dragenter", "dragover"]) elements.uploadZone.addEventListener(type, (event) => { event.preventDefault(); elements.uploadZone.classList.add("is-dragging"); });
  for (const type of ["dragleave", "drop"]) elements.uploadZone.addEventListener(type, (event) => { event.preventDefault(); elements.uploadZone.classList.remove("is-dragging"); });
  elements.uploadZone.addEventListener("drop", (event) => upload(event.dataTransfer?.files?.[0]));

  if (adminToken) authenticate(adminToken).catch(() => { sessionStorage.removeItem("psp-patcher-admin-token"); adminToken = ""; });
})();
