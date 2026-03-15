(function () {
  const SCRIPT_SRC = document.currentScript.src;
  const BASE_URL = SCRIPT_SRC.substring(0, SCRIPT_SRC.lastIndexOf("/"));

  function createWidget(cfg) {
    const color = (cfg && cfg.branding && cfg.branding.primaryColor) || "#1E40AF";
    const position = (cfg && cfg.branding && cfg.branding.bubblePosition) || "bottom-right";

    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "closed" });

    const posRight = position === "bottom-right" || position === "right";
    const posStyle = posRight ? "right:20px;" : "left:20px;";

    shadow.innerHTML = `
      <style>
        .va-bubble {
          position: fixed;
          bottom: 20px;
          ${posStyle}
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: ${color};
          color: #fff;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 26px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
          z-index: 999998;
          transition: transform 0.15s;
        }
        .va-bubble:hover { transform: scale(1.1); }
        .va-overlay {
          display: none;
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          z-index: 999999;
          justify-content: center;
          align-items: flex-end;
        }
        .va-overlay.open { display: flex; }
        .va-frame-wrap {
          width: 100%;
          max-width: 420px;
          height: 92vh;
          background: #fff;
          border-radius: 16px 16px 0 0;
          overflow: hidden;
          position: relative;
        }
        .va-close {
          position: absolute;
          top: 8px;
          right: 12px;
          background: none;
          border: none;
          font-size: 22px;
          color: #64748b;
          cursor: pointer;
          z-index: 10;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
        }
        .va-close:hover { background: #f1f5f9; }
        .va-iframe {
          width: 100%;
          height: 100%;
          border: none;
        }
        @media (min-width: 640px) {
          .va-overlay { align-items: center; }
          .va-frame-wrap {
            height: 680px;
            border-radius: 16px;
          }
        }
      </style>
      <button class="va-bubble" aria-label="Open voice agent">&#128172;</button>
      <div class="va-overlay">
        <div class="va-frame-wrap">
          <button class="va-close" aria-label="Close">&times;</button>
          <iframe class="va-iframe" src="${BASE_URL}/index.html"></iframe>
        </div>
      </div>
    `;

    const bubble = shadow.querySelector(".va-bubble");
    const overlay = shadow.querySelector(".va-overlay");
    const closeBtn = shadow.querySelector(".va-close");

    bubble.addEventListener("click", () => overlay.classList.add("open"));
    closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("open");
    });
  }

  fetch(BASE_URL + "/config.json")
    .then((r) => r.json())
    .then(createWidget)
    .catch(() => createWidget(null));
})();
