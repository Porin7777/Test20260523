const state = {
  statuses: [],
  companies: [],
  selectedStatus: "すべて",
  authenticated: false,
  csrfToken: ""
};

const totalCount = document.querySelector("#totalCount");
const activeCount = document.querySelector("#activeCount");
const offerCount = document.querySelector("#offerCount");
const loginToggle = document.querySelector("#loginToggle");
const authPanel = document.querySelector("#authPanel");
const adminPanel = document.querySelector("#adminPanel");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");
const logoutButton = document.querySelector("#logoutButton");
const companyForm = document.querySelector("#companyForm");
const statusSelect = document.querySelector("#statusSelect");
const statusTabs = document.querySelector("#statusTabs");
const companyGrid = document.querySelector("#companyGrid");
const companyTemplate = document.querySelector("#companyTemplate");

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(path, {
    credentials: "same-origin",
    headers,
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "処理に失敗しました。");
  }
  return payload;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function populateStatusOptions(select, selected) {
  select.innerHTML = "";
  state.statuses.forEach((status) => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    option.selected = status === selected;
    select.append(option);
  });
}

function updateSessionUi() {
  loginToggle.textContent = state.authenticated ? "管理者としてログイン中" : "管理者ログイン";
  adminPanel.classList.toggle("hidden", !state.authenticated);
  document.querySelectorAll(".admin-actions").forEach((element) => {
    element.classList.toggle("hidden", !state.authenticated);
  });
}

function renderSummary() {
  totalCount.textContent = state.companies.length;
  offerCount.textContent = state.companies.filter((company) => company.status === "内定").length;
  activeCount.textContent = state.companies.filter((company) => !["内定", "辞退・不採用"].includes(company.status)).length;
}

function renderTabs() {
  statusTabs.innerHTML = "";
  ["すべて", ...state.statuses].forEach((status) => {
    const count = status === "すべて"
      ? state.companies.length
      : state.companies.filter((company) => company.status === status).length;
    const button = document.createElement("button");
    button.className = `tab${state.selectedStatus === status ? " active" : ""}`;
    button.type = "button";
    button.role = "tab";
    button.textContent = `${status} (${count})`;
    button.addEventListener("click", () => {
      state.selectedStatus = status;
      render();
    });
    statusTabs.append(button);
  });
}

function renderComments(container, comments) {
  container.innerHTML = "";
  if (!comments.length) {
    const empty = document.createElement("p");
    empty.className = "memo";
    empty.textContent = "まだコメントはありません。";
    container.append(empty);
    return;
  }

  comments.forEach((comment) => {
    const item = document.createElement("div");
    item.className = "comment";

    const author = document.createElement("strong");
    author.textContent = comment.author;

    const body = document.createElement("p");
    body.textContent = comment.body;

    const time = document.createElement("time");
    time.dateTime = comment.createdAt;
    time.textContent = formatDate(comment.createdAt);

    item.append(author, body, time);
    container.append(item);
  });
}

function renderCompanies() {
  companyGrid.innerHTML = "";
  const filtered = state.selectedStatus === "すべて"
    ? state.companies
    : state.companies.filter((company) => company.status === state.selectedStatus);

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "この条件の会社はまだ登録されていません。";
    companyGrid.append(empty);
    return;
  }

  filtered.forEach((company) => {
    const node = companyTemplate.content.firstElementChild.cloneNode(true);
    const title = node.querySelector("h3");
    const pill = node.querySelector(".status-pill");
    const memo = node.querySelector(".memo");
    const adminActions = node.querySelector(".admin-actions");
    const editArea = node.querySelector(".edit-area");
    const editName = node.querySelector(".edit-name");
    const editStatus = node.querySelector(".edit-status");
    const editMemo = node.querySelector(".edit-memo");
    const commentForm = node.querySelector(".comment-form");
    const commentList = node.querySelector(".comment-list");

    title.textContent = company.name;
    pill.textContent = company.status;
    pill.dataset.status = company.status;
    memo.textContent = company.memo || "メモは未入力です。";
    adminActions.classList.toggle("hidden", !state.authenticated);
    renderComments(commentList, company.comments || []);
    populateStatusOptions(editStatus, company.status);
    editName.value = company.name;
    editMemo.value = company.memo || "";

    node.querySelector(".edit-button").addEventListener("click", () => {
      editArea.classList.remove("hidden");
    });

    node.querySelector(".cancel-button").addEventListener("click", () => {
      editArea.classList.add("hidden");
      editName.value = company.name;
      editStatus.value = company.status;
      editMemo.value = company.memo || "";
    });

    node.querySelector(".save-button").addEventListener("click", async () => {
      await api(`/api/companies/${company.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: editName.value,
          status: editStatus.value,
          memo: editMemo.value
        })
      });
      await loadCompanies();
    });

    node.querySelector(".delete-button").addEventListener("click", async () => {
      if (!confirm(`${company.name} を削除しますか？`)) return;
      await api(`/api/companies/${company.id}`, { method: "DELETE" });
      await loadCompanies();
    });

    commentForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(commentForm);
      await api(`/api/companies/${company.id}/comments`, {
        method: "POST",
        body: JSON.stringify({
          author: formData.get("author"),
          body: formData.get("body")
        })
      });
      commentForm.reset();
      await loadCompanies();
    });

    companyGrid.append(node);
  });
}

function render() {
  renderSummary();
  renderTabs();
  renderCompanies();
  updateSessionUi();
}

async function loadSession() {
  const session = await api("/api/me");
  state.authenticated = session.authenticated;
  state.csrfToken = session.csrfToken || state.csrfToken;
}

async function loadCompanies() {
  const payload = await api("/api/companies");
  state.statuses = payload.statuses;
  state.companies = payload.companies;
  populateStatusOptions(statusSelect, state.statuses[0]);
  render();
}

loginToggle.addEventListener("click", () => {
  if (state.authenticated) return;
  authPanel.classList.toggle("hidden");
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "";
  const formData = new FormData(loginForm);

  try {
    const session = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password")
      })
    });
    state.authenticated = session.authenticated;
    state.csrfToken = session.csrfToken || state.csrfToken;
    authPanel.classList.add("hidden");
    loginForm.reset();
    render();
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  state.authenticated = false;
  state.csrfToken = "";
  render();
});

companyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(companyForm);
  await api("/api/companies", {
    method: "POST",
    body: JSON.stringify({
      name: formData.get("name"),
      status: formData.get("status"),
      memo: formData.get("memo")
    })
  });
  companyForm.reset();
  populateStatusOptions(statusSelect, state.statuses[0]);
  await loadCompanies();
});

(async function init() {
  await loadSession();
  await loadCompanies();
})().catch((error) => {
  companyGrid.innerHTML = `<div class="empty">${error.message}</div>`;
});
