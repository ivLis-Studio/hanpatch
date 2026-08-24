(() => {
  "use strict";
  const list = document.querySelector("#patcher-list");
  const count = document.querySelector("#patcher-count");
  const empty = document.querySelector("#empty-state");

  function card(patcher) {
    const link = document.createElement("a");
    link.className = "patcher-card";
    link.href = patcher.url;
    const top = document.createElement("div"); top.className = "card-top";
    const version = document.createElement("span"); version.className = "version"; version.textContent = `VERSION ${patcher.version}`;
    const disc = document.createElement("span"); disc.className = "disc"; disc.textContent = patcher.input.discId;
    top.append(version, disc);
    const title = document.createElement("h3"); title.textContent = patcher.title;
    const description = document.createElement("p"); description.textContent = patcher.description;
    const bottom = document.createElement("div"); bottom.className = "card-bottom";
    const label = document.createElement("span"); label.textContent = "패처 열기";
    const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.setAttribute("aria-hidden", "true"); arrow.textContent = "→";
    bottom.append(label, arrow);
    link.append(top, title, description, bottom);
    return link;
  }

  fetch("/api/patchers", { cache: "no-store" })
    .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
    .then(({ patchers }) => {
      count.textContent = `${patchers.length}개 패처`;
      list.replaceChildren(...patchers.map(card));
      empty.hidden = patchers.length !== 0;
    })
    .catch(() => { count.textContent = "불러오기 실패"; empty.hidden = false; empty.querySelector("strong").textContent = "패처 목록을 불러오지 못했습니다."; });
})();
