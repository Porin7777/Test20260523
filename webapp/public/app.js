const state = {
  statuses: [],
  desireLevels: [],
  companies: [],
  todos: [],
  freeComments: [],
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
const desireLevelSelect = document.querySelector("#desireLevelSelect");
const statusTabs = document.querySelector("#statusTabs");
const companyGrid = document.querySelector("#companyGrid");
const companyTemplate = document.querySelector("#companyTemplate");
const todoForm = document.querySelector("#todoForm");
const todoList = document.querySelector("#todoList");
const freeCommentForm = document.querySelector("#freeCommentForm");
const freeCommentList = document.querySelector("#freeCommentList");

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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function populateStatusOptions(select, selected) {
  populateOptions(select, state.statuses, selected);
}

function populateDesireLevelOptions(select, selected) {
  populateOptions(select, state.desireLevels, selected);
}

function populateOptions(select, values, selected) {
  select.innerHTML = "";
  values.forEach((status) => {
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
  todoForm.classList.toggle("hidden", !state.authenticated);
  document.querySelectorAll(".admin-actions").forEach((element) => {
    element.classList.toggle("hidden", !state.authenticated);
  });
}

function formatDateOnly(value) {
  if (!value) return "期限なし";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return "期限なし";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
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

    const header = document.createElement("div");
    header.className = "comment-header";

    const author = document.createElement("strong");
    author.textContent = comment.author;

    header.append(author);

    if (state.authenticated) {
      const deleteButton = document.createElement("button");
      deleteButton.className = "comment-delete-button";
      deleteButton.type = "button";
      deleteButton.textContent = "削除";
      deleteButton.addEventListener("click", async () => {
        if (!confirm("このコメントを削除しますか？")) return;
        await api(`/api/free-comments/${comment.id}`, { method: "DELETE" });
        await loadFreeComments();
      });
      header.append(deleteButton);
    }

    const body = document.createElement("p");
    body.textContent = comment.body;

    const time = document.createElement("time");
    time.dateTime = comment.createdAt;
    time.textContent = formatDate(comment.createdAt);

    item.append(header, body, time);
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
    const desirePill = node.querySelector(".desire-pill");
    const memo = node.querySelector(".memo");
    const adminActions = node.querySelector(".admin-actions");
    const editArea = node.querySelector(".edit-area");
    const editName = node.querySelector(".edit-name");
    const editStatus = node.querySelector(".edit-status");
    const editDesireLevel = node.querySelector(".edit-desire-level");
    const editUrl = node.querySelector(".edit-url");
    const editMemo = node.querySelector(".edit-memo");

    title.innerHTML = "";
    if (company.url) {
      const link = document.createElement("a");
      link.href = company.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = company.name;
      title.append(link);
    } else {
      title.textContent = company.name;
    }
    pill.textContent = company.status;
    pill.dataset.status = company.status;
    desirePill.textContent = `志望度: ${company.desireLevel || "未設定"}`;
    desirePill.dataset.desireLevel = company.desireLevel || "未設定";
    memo.textContent = company.memo || "メモは未入力です。";
    adminActions.classList.toggle("hidden", !state.authenticated);
    populateStatusOptions(editStatus, company.status);
    populateDesireLevelOptions(editDesireLevel, company.desireLevel || "未設定");
    editName.value = company.name;
    editUrl.value = company.url || "";
    editMemo.value = company.memo || "";

    node.querySelector(".edit-button").addEventListener("click", () => {
      editArea.classList.remove("hidden");
    });

    node.querySelector(".cancel-button").addEventListener("click", () => {
      editArea.classList.add("hidden");
      editName.value = company.name;
      editStatus.value = company.status;
      editDesireLevel.value = company.desireLevel || "未設定";
      editUrl.value = company.url || "";
      editMemo.value = company.memo || "";
    });

    node.querySelector(".save-button").addEventListener("click", async () => {
      await api(`/api/companies/${company.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: editName.value,
          status: editStatus.value,
          desireLevel: editDesireLevel.value,
          url: editUrl.value,
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

    companyGrid.append(node);
  });
}

function renderTodos() {
  todoList.innerHTML = "";
  if (!state.todos.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "やることはまだ登録されていません。";
    todoList.append(empty);
    return;
  }

  state.todos.forEach((todo) => {
    const item = document.createElement("article");
    item.className = `todo-item${todo.done ? " done" : ""}`;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = todo.done;
    check.disabled = !state.authenticated;
    check.addEventListener("change", async () => {
      await api(`/api/todos/${todo.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: todo.title,
          dueDate: todo.dueDate,
          done: check.checked
        })
      });
      await loadTodos();
    });

    const text = document.createElement("div");
    text.className = "todo-text";
    const title = document.createElement("strong");
    title.textContent = todo.title;
    const due = document.createElement("time");
    due.textContent = formatDateOnly(todo.dueDate);
    if (todo.dueDate) due.dateTime = todo.dueDate;
    text.append(title, due);

    item.append(check, text);

    if (state.authenticated) {
      const deleteButton = document.createElement("button");
      deleteButton.className = "todo-delete-button";
      deleteButton.type = "button";
      deleteButton.textContent = "削除";
      deleteButton.addEventListener("click", async () => {
        if (!confirm("このやることを削除しますか？")) return;
        await api(`/api/todos/${todo.id}`, { method: "DELETE" });
        await loadTodos();
      });
      item.append(deleteButton);
    }

    todoList.append(item);
  });
}

function render() {
  renderSummary();
  renderTabs();
  renderTodos();
  renderCompanies();
  renderComments(freeCommentList, state.freeComments);
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
  state.desireLevels = payload.desireLevels || ["未設定", "第一志望", "高", "中", "低"];
  state.companies = payload.companies;
  populateStatusOptions(statusSelect, state.statuses[0]);
  populateDesireLevelOptions(desireLevelSelect, state.desireLevels[0]);
  render();
}

async function loadTodos() {
  const payload = await api("/api/todos");
  state.todos = payload.todos;
  render();
}

async function loadFreeComments() {
  const payload = await api("/api/free-comments");
  state.freeComments = payload.comments;
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
      desireLevel: formData.get("desireLevel"),
      url: formData.get("url"),
      memo: formData.get("memo")
    })
  });
  companyForm.reset();
  populateStatusOptions(statusSelect, state.statuses[0]);
  populateDesireLevelOptions(desireLevelSelect, state.desireLevels[0]);
  await loadCompanies();
});

todoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(todoForm);
  await api("/api/todos", {
    method: "POST",
    body: JSON.stringify({
      title: formData.get("title"),
      dueDate: formData.get("dueDate")
    })
  });
  todoForm.reset();
  await loadTodos();
});

freeCommentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(freeCommentForm);
  await api("/api/free-comments", {
    method: "POST",
    body: JSON.stringify({
      author: formData.get("author"),
      body: formData.get("body")
    })
  });
  freeCommentForm.reset();
  await loadFreeComments();
});

(async function init() {
  await loadSession();
  await loadCompanies();
  await loadTodos();
  await loadFreeComments();
})().catch((error) => {
  companyGrid.innerHTML = `<div class="empty">${error.message}</div>`;
});
