(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    actionNote: $("#action-note"),
    brandTitle: $("#brand-title"),
    cancelButton: $("#cancel-button"),
    changeFile: $("#change-file"),
    compatibility: $("#compatibility"),
    consoleLog: $("#console-log"),
    description: $("#description"),
    dropCopy: $("#drop-copy"),
    dropZone: $("#drop-zone"),
    fileInput: $("#file-input"),
    fileMeta: $("#file-meta"),
    fileName: $("#file-name"),
    fileSummary: $("#file-summary"),
    fileType: $("#file-type"),
    footerTitle: $("#footer-title"),
    liveRegion: $("#live-region"),
    localNoticeCopy: $("#local-notice-copy"),
    noticeList: $("#notice-list"),
    pageTitle: $("#page-title"),
    patchHeading: $("#patch-heading"),
    patchSizeCopy: $("#patch-size-copy"),
    phaseLabel: $("#phase-label"),
    progressBar: $("#progress-bar"),
    progressPanel: $("#progress-panel"),
    progressTrack: $("#progress-track"),
    progressValue: $("#progress-value"),
    resultHash: $("#result-hash"),
    resultName: $("#result-name"),
    resultPanel: $("#result-panel"),
    startButton: $("#start-button"),
    statusMessage: $("#status-message"),
    variantList: $("#variant-list"),
    versionBadge: $("#version-badge"),
  };

  const phaseOrder = ["validate", "download", "copy", "apply", "verify"];
  const phaseNames = {
    validate: "원본 확인",
    download: "패치 준비",
    copy: "ISO 복사",
    apply: "패치 적용",
    verify: "결과 검증",
    done: "완료",
  };

  let manifest = null;
  let sourceFile = null;
  let sourceHandle = null;
  let sourceFiles = [];
  let worker = null;
  let running = false;
  let lastConsolePhase = null;
  let activeOutputParent = null;
  let activeOutputName = null;

  function isDirectoryMode() {
    return manifest?.input?.mode === "directory";
  }

  function hasSource() {
    return isDirectoryMode() ? sourceFiles.length > 0 : Boolean(sourceFile);
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount.toFixed(unit === 0 ? 0 : amount >= 100 ? 0 : 1)} ${units[unit]}`;
  }

  function announce(message) {
    elements.liveRegion.textContent = "";
    window.setTimeout(() => { elements.liveRegion.textContent = message; }, 20);
  }

  function appendLog(message, tone = "") {
    const line = document.createElement("div");
    line.className = `console-line${tone ? ` is-${tone}` : ""}`;
    line.textContent = `> ${message}`;
    elements.consoleLog.append(line);
    elements.consoleLog.scrollTop = elements.consoleLog.scrollHeight;
  }

  function resetConsole(message) {
    elements.consoleLog.replaceChildren();
    appendLog(message, "muted");
    lastConsolePhase = null;
  }

  function showCompatibility(message) {
    elements.compatibility.textContent = message;
    elements.compatibility.hidden = !message;
  }

  function compatibilityError() {
    const missing = [];
    if (isDirectoryMode()) {
      if (!("showDirectoryPicker" in window)) missing.push("로컬 폴더 선택과 저장");
    } else if (!("showSaveFilePicker" in window)) missing.push("로컬 파일 저장");
    if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) missing.push("브라우저 패치 저장소");
    if (!("DecompressionStream" in window)) missing.push("패치 압축 해제");
    if (!("Worker" in window)) missing.push("백그라운드 처리");
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      missing.push("HTTPS 보안 연결");
    }
    return missing.length
      ? `이 브라우저에서는 ${missing.join(", ")} 기능을 사용할 수 없습니다. 최신 Chrome 또는 Edge 데스크톱 버전을 사용하세요.`
      : "";
  }

  function setProgress(phase, fraction, message) {
    const normalized = Math.max(0, Math.min(1, Number(fraction) || 0));
    const percent = Math.round(normalized * 100);
    elements.progressPanel.hidden = false;
    elements.phaseLabel.textContent = phaseNames[phase] ?? "처리 중";
    elements.statusMessage.textContent = message ?? "처리 중입니다.";
    elements.progressValue.textContent = `${percent}%`;
    elements.progressBar.style.width = `${percent}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(percent));

    if (phase !== lastConsolePhase) {
      appendLog(
        phase === "done" ? "모든 패치 단계와 결과 검증이 완료됐습니다." : `${phaseNames[phase] ?? "처리"} 단계를 시작합니다.`,
        phase === "done" ? "ok" : "warn",
      );
      lastConsolePhase = phase;
    }

    const currentIndex = phase === "done" ? phaseOrder.length : phaseOrder.indexOf(phase);
    for (const [index, node] of [...document.querySelectorAll(".phase-list li")].entries()) {
      node.classList.toggle("is-active", index === currentIndex);
      node.classList.toggle("is-done", index < currentIndex || phase === "done");
    }
  }

  function setRunning(value) {
    running = value;
    elements.startButton.disabled = value || !hasSource() || Boolean(compatibilityError());
    elements.cancelButton.hidden = !value;
    if (value) elements.cancelButton.disabled = false;
    elements.changeFile.disabled = value;
    elements.dropZone.setAttribute("aria-disabled", String(value || !manifest));
    elements.actionNote.textContent = value
      ? "패치가 끝날 때까지 탭을 닫지 마세요."
      : isDirectoryMode()
        ? "원본 DLC 폴더는 수정하지 않고 새 결과 폴더를 만듭니다."
        : "원본 ISO는 수정하지 않고 새 파일을 만듭니다.";
  }

  function resetResult() {
    elements.resultPanel.hidden = true;
    elements.resultHash.textContent = "";
    elements.resultName.textContent = "";
  }

  async function useFile(file, handle = null) {
    if (!file) return;
    const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    if (!manifest.input.extensions.includes(extension)) {
      showCompatibility(`지원하지 않는 파일입니다. ${manifest.input.extensions.join(", ")} 파일을 선택하세요.`);
      announce("지원하지 않는 파일입니다.");
      return;
    }
    sourceFile = file;
    sourceHandle = handle;
    sourceFiles = [];
    elements.fileName.textContent = file.name;
    elements.fileMeta.textContent = `${formatBytes(file.size)} · ${new Date(file.lastModified).toLocaleString("ko-KR")}`;
    elements.fileSummary.hidden = false;
    elements.dropZone.hidden = true;
    resetResult();
    elements.progressPanel.hidden = true;
    resetConsole(`파일 선택됨: ${file.name} (${formatBytes(file.size)})`);
    appendLog("패치 진행 버튼을 누르면 새 결과 파일을 만들기 시작합니다.", "muted");
    const error = compatibilityError();
    showCompatibility(error);
    setRunning(false);
    announce(`${file.name} 파일이 선택됐습니다.`);
  }

  async function requiredFilesFromDirectory(handle) {
    const files = [];
    for (const entry of manifest.engineData.entries) {
      try {
        files.push(await (await handle.getFileHandle(entry.name)).getFile());
      } catch (error) {
        if (error?.name === "NotFoundError") throw new Error(`선택한 폴더에 ${entry.name} 파일이 없습니다.`);
        throw error;
      }
    }
    return files;
  }

  async function useFileSet(files, directoryName) {
    const byName = new Map();
    for (const file of files) {
      if (byName.has(file.name)) {
        showCompatibility(`선택한 폴더에 같은 이름의 파일이 중복됩니다: ${file.name}`);
        return;
      }
      byName.set(file.name, file);
    }
    const required = [];
    for (const entry of manifest.engineData.entries) {
      const file = byName.get(entry.name);
      if (!file) {
        showCompatibility(`선택한 폴더에 필수 파일이 없습니다: ${entry.name}`);
        announce("필수 DLC 파일이 없는 폴더입니다.");
        return;
      }
      required.push(file);
    }
    sourceFile = null;
    sourceHandle = null;
    sourceFiles = required;
    const total = required.reduce((sum, file) => sum + file.size, 0);
    elements.fileName.textContent = directoryName;
    elements.fileMeta.textContent = `${required.length}개 필수 파일 · ${formatBytes(total)}`;
    elements.fileSummary.hidden = false;
    elements.dropZone.hidden = true;
    resetResult();
    elements.progressPanel.hidden = true;
    resetConsole(`DLC 폴더 선택됨: ${directoryName} (${required.length}개 파일)`);
    appendLog("패치 진행 버튼을 누르면 별도의 결과 폴더를 만들기 시작합니다.", "muted");
    const error = compatibilityError();
    showCompatibility(error);
    setRunning(false);
    announce(`${directoryName} DLC 폴더가 선택됐습니다.`);
  }

  async function sourceFromDrop(event) {
    const item = [...(event.dataTransfer?.items ?? [])].find((candidate) => candidate.kind === "file");
    if (!item) return { file: null, handle: null, files: [] };
    let handle = null;
    if (typeof item.getAsFileSystemHandle === "function") {
      try {
        handle = await item.getAsFileSystemHandle();
      } catch {
        // The normal File fallback below is still safe and supported.
      }
    }
    if (handle?.kind === "file") {
      if (isDirectoryMode()) throw new Error("파일이 아니라 DLC 폴더를 선택하세요.");
      return { file: await handle.getFile(), handle };
    }
    if (handle?.kind === "directory") {
      if (!isDirectoryMode()) throw new Error("폴더가 아니라 원본 ISO 파일을 선택하세요.");
      return { files: await requiredFilesFromDirectory(handle), handle };
    }
    return { file: item.getAsFile(), handle: null, files: [...(event.dataTransfer?.files ?? [])] };
  }

  function configureManifest(config) {
    manifest = config;
    const directoryMode = isDirectoryMode();
    elements.fileInput.accept = directoryMode ? "" : config.input.extensions.join(",");
    elements.fileInput.multiple = directoryMode;
    if (directoryMode) elements.fileInput.setAttribute("webkitdirectory", "");
    else elements.fileInput.removeAttribute("webkitdirectory");
    document.title = config.title;
    elements.brandTitle.textContent = config.shortTitle;
    elements.footerTitle.textContent = config.shortTitle;
    elements.pageTitle.textContent = config.title;
    elements.versionBadge.textContent = `V ${config.version}`;
    elements.description.textContent = config.description;
    elements.patchHeading.textContent = config.input.label;
    elements.fileType.textContent = directoryMode ? "DIR" : "ISO";
    elements.dropCopy.querySelector("strong").textContent = directoryMode
      ? "여기에 DLC 폴더를 놓으세요"
      : "여기에 ISO 파일을 놓으세요";
    elements.dropCopy.querySelector("span").textContent = directoryMode
      ? "또는 클릭해서 원본 DLC 폴더 선택하기"
      : "또는 클릭해서 원본 파일 선택하기";
    elements.localNoticeCopy.innerHTML = directoryMode
      ? "선택한 원본과 완성 DLC는 <strong>이 브라우저 안에서만 처리</strong>되며 서버로 전송되지 않습니다."
      : "선택한 원본과 완성 ISO는 <strong>이 브라우저 안에서만 처리</strong>되며 서버로 전송되지 않습니다.";
    phaseNames.copy = directoryMode ? "결과 폴더 준비" : "ISO 복사";
    document.querySelector('[data-phase="copy"] strong').textContent = phaseNames.copy;
    elements.changeFile.textContent = directoryMode ? "다른 폴더" : "다른 파일";
    elements.variantList.replaceChildren(...config.input.supportedVariants.map((variant) => {
      const chip = document.createElement("span");
      chip.textContent = variant;
      return chip;
    }));
    elements.noticeList.replaceChildren(...config.notices.map((notice) => {
      const item = document.createElement("li");
      item.textContent = notice;
      return item;
    }));
    elements.patchSizeCopy.textContent = `${formatBytes(config.patch.size)} 크기의 차이 데이터만 다운로드하고 브라우저에 보관합니다.`;
    elements.dropZone.setAttribute("aria-disabled", "false");
    setRunning(false);
    resetConsole(`${config.shortTitle} v${config.version} 패치 정보를 불러왔습니다.`);
  }

  async function createUniqueDirectory(parent, requestedName) {
    for (let index = 1; index <= 100; index += 1) {
      const name = index === 1 ? requestedName : `${requestedName}_${index}`;
      try {
        await parent.getDirectoryHandle(name);
      } catch (error) {
        if (error?.name === "NotFoundError") {
          return { name, handle: await parent.getDirectoryHandle(name, { create: true }) };
        }
        throw error;
      }
    }
    throw new Error("사용하지 않은 DLC 결과 폴더 이름을 찾지 못했습니다.");
  }

  async function cleanupPartialOutput() {
    if (!activeOutputParent || !activeOutputName) return;
    await activeOutputParent.removeEntry(activeOutputName, { recursive: true }).catch(() => {});
    activeOutputParent = null;
    activeOutputName = null;
  }

  async function startPatch() {
    if (running || !hasSource() || !manifest) return;
    resetResult();
    let outputHandle;
    let outputName;
    try {
      if (isDirectoryMode()) {
        const parent = await window.showDirectoryPicker({ mode: "readwrite" });
        const created = await createUniqueDirectory(parent, manifest.output.suggestedName);
        outputHandle = created.handle;
        outputName = created.name;
        activeOutputParent = parent;
        activeOutputName = created.name;
      } else {
        outputHandle = await window.showSaveFilePicker({
          suggestedName: manifest.output.suggestedName,
          types: [{
            description: "PSP ISO 이미지",
            accept: { "application/x-iso9660-image": [".iso"] },
          }],
        });
        outputName = outputHandle.name;
        if (sourceHandle && typeof sourceHandle.isSameEntry === "function" && await sourceHandle.isSameEntry(outputHandle)) {
          throw new Error("원본 ISO와 같은 파일에 저장할 수 없습니다. 다른 이름을 선택하세요.");
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      await cleanupPartialOutput();
      showCompatibility(error.message ?? String(error));
      announce(error.message ?? "저장 파일을 선택하지 못했습니다.");
      return;
    }

    setRunning(true);
    showCompatibility("");
    appendLog(`결과 저장 위치 선택됨: ${outputName}`, "ok");
    setProgress("validate", 0, "패치 엔진을 준비하고 있습니다.");
    worker = new Worker(isDirectoryMode() ? "assets/dlc-patch-worker.js" : "assets/patch-worker.js");
    worker.addEventListener("message", async ({ data }) => {
      if (data.type === "progress") {
        setProgress(data.phase, data.fraction, data.message);
      } else if (data.type === "done") {
        setProgress("done", 1, "모든 검증을 통과했습니다.");
        elements.resultName.textContent = data.outputName;
        elements.resultHash.textContent = data.summary ?? `SHA-256  ${data.sha256}`;
        elements.resultPanel.hidden = false;
        setRunning(false);
        appendLog(`${isDirectoryMode() ? "결과 폴더" : "결과 파일"} 준비 완료: ${data.outputName}`, "ok");
        appendLog(data.summary ?? `SHA-256 ${data.sha256}`, "ok");
        announce("한국어 패치와 결과 검증이 완료됐습니다.");
        activeOutputParent = null;
        activeOutputName = null;
        worker.terminate();
        worker = null;
      } else if (data.type === "cancelled") {
        await cleanupPartialOutput();
        setRunning(false);
        elements.progressPanel.hidden = true;
        appendLog("사용자 요청으로 패치를 중단했습니다.", "warn");
        announce("패치를 중단했습니다.");
        worker.terminate();
        worker = null;
      } else if (data.type === "error") {
        await cleanupPartialOutput();
        showCompatibility(data.message);
        setRunning(false);
        elements.progressPanel.hidden = true;
        appendLog(`패치 오류: ${data.message}`, "error");
        announce(`패치 오류: ${data.message}`);
        worker.terminate();
        worker = null;
      }
    });
    worker.addEventListener("error", async (event) => {
      await cleanupPartialOutput();
      showCompatibility(`패치 엔진 오류: ${event.message}`);
      setRunning(false);
      elements.progressPanel.hidden = true;
      appendLog(`패치 엔진 오류: ${event.message}`, "error");
      worker?.terminate();
      worker = null;
    });
    const message = {
      type: "start",
      manifest: {
        ...manifest,
        patch: {
          ...manifest.patch,
          url: new URL(manifest.patch.url, location.href).href,
        },
      },
    };
    if (isDirectoryMode()) {
      Object.assign(message, { files: sourceFiles, outputDirectory: outputHandle, outputName });
    } else {
      Object.assign(message, { file: sourceFile, outputHandle });
    }
    worker.postMessage(message);
  }

  async function selectSource() {
    if (running || !manifest) return;
    if (!isDirectoryMode() || !("showDirectoryPicker" in window)) {
      elements.fileInput.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await useFileSet(await requiredFilesFromDirectory(handle), handle.name);
    } catch (error) {
      if (error?.name === "AbortError") return;
      showCompatibility(error.message ?? String(error));
      announce(error.message ?? "DLC 폴더를 선택하지 못했습니다.");
    }
  }

  elements.dropZone.addEventListener("click", selectSource);
  elements.dropZone.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !running && manifest) {
      event.preventDefault();
      selectSource();
    }
  });
  elements.fileInput.addEventListener("change", () => {
    if (isDirectoryMode()) {
      const files = [...(elements.fileInput.files ?? [])];
      const directoryName = files[0]?.webkitRelativePath?.split("/")[0] || manifest.input.discId;
      useFileSet(files, directoryName);
    } else {
      useFile(elements.fileInput.files?.[0]);
    }
  });
  elements.changeFile.addEventListener("click", selectSource);
  elements.startButton.addEventListener("click", startPatch);
  elements.cancelButton.addEventListener("click", () => {
    elements.cancelButton.disabled = true;
    appendLog("작업 중단을 요청했습니다.", "warn");
    worker?.postMessage({ type: "cancel" });
  });

  for (const eventName of ["dragenter", "dragover"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!running && manifest) elements.dropZone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("is-dragging");
    });
  }
  elements.dropZone.addEventListener("drop", async (event) => {
    if (running || !manifest) return;
    try {
      const { file, files, handle } = await sourceFromDrop(event);
      if (isDirectoryMode()) await useFileSet(files, handle?.name ?? manifest.input.discId);
      else await useFile(file, handle);
    } catch (error) {
      showCompatibility(error.message ?? String(error));
      announce(error.message ?? "원본을 선택하지 못했습니다.");
    }
  });
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => {
    if (!elements.dropZone.contains(event.target)) event.preventDefault();
  });

  fetch("manifest.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(configureManifest)
    .catch((error) => {
      showCompatibility(`패치 정보를 불러오지 못했습니다: ${error.message}`);
      elements.description.textContent = "서버 설정과 패치 파일을 확인해 주세요.";
      appendLog(`패치 정보를 불러오지 못했습니다: ${error.message}`, "error");
    });
})();
