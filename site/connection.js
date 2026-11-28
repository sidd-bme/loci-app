(() => {
  const stages = [
    {
      key: "request",
      step: "Request",
      name: "Assistant",
      detail: "Codex or Antigravity",
      description: "“Find cells in the membrane channel and measure actin.”",
      duration: 2600,
      art: `
        <rect x="14" y="17" width="92" height="58" rx="8" class="lc-plate"/>
        <path d="M14 33h92M25 25h2m5 0h2m5 0h2" class="lc-fine"/>
        <path d="m37 44 9 7-9 7m17 0h16" class="lc-bright"/>
        <path d="M84 48h9m-9 7h5" class="lc-fine"/>
      `,
    },
    {
      key: "grant",
      step: "Grant",
      name: "Study connection",
      detail: "Scoped access via MCP",
      description: "Choose the image region, the channels the assistant can use, and the operations it can request.",
      duration: 3000,
      art: `
        <path d="M14 31h15l10 10m-25 5h22m-22 15h15l10-10M106 31H91L81 41m25 5H84m22 15H91L81 51" class="lc-fine"/>
        <path d="M43 20h34l12 12v28L77 72H43L31 60V32Z" class="lc-plate"/>
        <path d="M47 38h6m14 0h6m-26 8h26m-26 8h6m14 0h6" class="lc-fine"/>
        <circle cx="53" cy="38" r="2" class="lc-junction"/><circle cx="67" cy="54" r="2" class="lc-junction"/>
        <path d="m55 46 5-5 5 5-5 5Z" class="lc-bright"/>
      `,
    },
    {
      key: "run",
      step: "Run",
      name: "Local Loci worker",
      detail: "Membrane channel",
      description: "The installed Cellpose-SAM v2 model uses the membrane channel to predict cell boundaries on your computer.",
      duration: 3450,
      art: `
        <path d="m14 61 57 18 35-19-57-18Z" class="lc-plate"/>
        <path d="m14 49 57 18 35-19-57-18Z" class="lc-plate"/>
        <path d="m14 37 57 18 35-19-57-18Z" class="lc-plate lc-specimen"/>
        <path d="m27 41 34-19m-20 23 34-19m-20 23 34-19m-20 23 34-19M25 31l57 18M37 25l57 18" class="lc-fine lc-plane-grid"/>
        <path d="m35 39 15-8 11 3 13-2 10 4-8 6-14 3-11-3-6 1Z" class="lc-bright"/>
        <path d="m48 18 57 18" class="lc-sweep lc-bright"/>
      `,
    },
    {
      key: "preview",
      step: "Preview",
      name: "Model preview",
      detail: "Predicted cell outlines",
      description: "Loci keeps the preview linked to its source region and model run, with the boundaries overlaid on the image.",
      duration: 3350,
      art: `
        <rect x="16" y="13" width="88" height="66" rx="6" class="lc-plate lc-specimen"/>
        <path d="M21 29v-9h9m60 0h9v9M21 63v9h9m60 0h9v-9" class="lc-fine"/>
        <path d="M27 38c11-12 18-10 24 1s9 11 19 1 13-8 21-2m-64 8c15-12 23 6 29 9s18-7 33-9M33 55c12-12 16 10 30 8s14-12 25-12" class="lc-fine lc-filaments"/>
        <path d="M28 36c4-6 13-8 19-5s4 12-2 16-12 5-16-1c-2-3-3-6-1-10Z
                 M54 30c3-6 13-7 20-5s7 7 3 11-10 6-16 5-10-7-7-11Z
                 M79 43c5-7 13-6 16-1s0 12-5 16-11 1-13-4c-2-4-1-8 2-11Z
                 M45 53c6-6 14-8 21-5s7 11-1 16-17 2-21-1c-3-2-2-7 1-10Z" class="lc-bright lc-contours"/>
      `,
    },
    {
      key: "review",
      step: "Review",
      name: "Researcher review",
      detail: "Inspect and approve",
      description: "Inspect the outlines in Loci. Approve that exact preview once to save it, or deny it.",
      duration: 3500,
      art: `
        <path d="M36 21H21v15m63-15h15v15M21 56v15h15m63-15v15H84" class="lc-fine"/>
        <path d="M28 46c9-12 20-18 32-18s23 6 32 18c-9 12-20 18-32 18s-23-6-32-18Z" class="lc-plate"/>
        <circle cx="60" cy="46" r="17" class="lc-review-ring"/>
        <circle cx="60" cy="46" r="10" class="lc-bright"/>
        <circle cx="60" cy="46" r="3" class="lc-junction"/>
        <circle cx="90" cy="64" r="12" class="lc-plate lc-seal"/>
        <path d="m86 64 3 3 5-6" class="lc-bright lc-seal"/>
      `,
    },
    {
      key: "save",
      step: "Save",
      name: "Saved result",
      detail: "Cell outlines + actin measurements",
      description: "Reopen the outlines and each cell’s mean intensity from the raw actin channel in the study.",
      duration: 3000,
      art: `
        <rect x="22" y="14" width="76" height="64" rx="7" class="lc-plate"/>
        <path d="M22 32h76M22 47h76m-76 15h76m-53-30v46" class="lc-fine"/>
        <path d="M31 23h25m8 0h17" class="lc-bright"/>
        <path d="M31 40h5m-5 15h5m-5 15h5" class="lc-fine"/>
        <path d="M55 40h30m-30 15h20m-20 15h26" class="lc-bright lc-result-bars"/>
        <path d="M55 40h30" pathLength="1" class="lc-result-row"/>
        <path d="M55 55h20" pathLength="1" class="lc-result-row"/>
        <path d="M55 70h26" pathLength="1" class="lc-result-row"/>
      `,
    },
  ];

  const playIcon = '<path d="M6 4.5 15 10l-9 5.5Z" fill="currentColor" stroke="none"/>';
  const pauseIcon = '<path d="M7 5v10m6-10v10"/>';
  const replayIcon = '<path d="M3.5 8a6.5 6.5 0 1 1 .6 6m-.6-10v4h4"/>';
  const arrivalTime = 1000;
  const svgNS = "http://www.w3.org/2000/svg";
  let instance = 0;

  function clampUnit(value) {
    return Math.min(1, Math.max(0, value));
  }

  function stageMarkup(stage) {
    return `<li class="lc-node" data-node="${stage.key}">
      <svg class="lc-art" viewBox="0 0 120 92" aria-hidden="true">${stage.art}</svg>
      <div class="lc-label"><span>${stage.name}</span><span>${stage.detail}</span></div>
    </li>`;
  }

  function createTracks(svg) {
    return stages.slice(1).map(() => {
      const rail = document.createElementNS(svgNS, "path");
      const trace = document.createElementNS(svgNS, "path");
      const arrow = document.createElementNS(svgNS, "path");
      rail.setAttribute("class", "lc-rail");
      trace.setAttribute("class", "lc-trace");
      arrow.setAttribute("class", "lc-arrow");
      svg.append(rail, trace, arrow);
      return { rail, trace, arrow, length: 0 };
    });
  }

  class LociConnection extends HTMLElement {
    connectedCallback() {
      if (!this.querySelector(".lc-figure")) this.mount();
      this.motion = matchMedia("(prefers-reduced-motion: reduce)");
      this.motion.addEventListener("change", this.onMotionChange);
      this.onMotionChange();
      this.observer = new ResizeObserver(() => this.layoutTracks());
      this.observer.observe(this.map);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      this.layoutTracks();
    }

    disconnectedCallback() {
      this.pause();
      this.observer?.disconnect();
      this.motion?.removeEventListener("change", this.onMotionChange);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }

    mount() {
      const id = `loci-connection-${++instance}`;
      const template = document.createElement("template");
      template.innerHTML = `<figure class="lc-figure" aria-label="From an assistant request to a saved measurement">
        <div class="lc-map">
          <span class="lc-zone lc-zone-host" aria-hidden="true">Assistant host</span>
          <span class="lc-zone lc-zone-study" aria-hidden="true">Loci study</span>
          <div class="lc-study" aria-hidden="true"></div>
          <svg class="lc-routes" aria-hidden="true">
            <circle class="lc-signal-ring" r="7" visibility="hidden"/>
            <circle class="lc-signal" r="3" visibility="hidden"/>
          </svg>
          <ol class="lc-nodes" aria-label="Workflow from request to saved result">
            ${stages.map(stageMarkup).join("")}
          </ol>
        </div>
        <figcaption class="lc-footer">
          <div class="lc-caption" id="${id}-detail" aria-live="polite" aria-atomic="true"></div>
          <div class="lc-controls">
            <div class="lc-steps" role="group" aria-label="Workflow steps">
              ${stages.map(stage => `<button type="button" aria-controls="${id}-detail">${stage.step}</button>`).join("")}
            </div>
            <button class="lc-play" type="button" aria-label="Play the connection animation">
              <svg viewBox="0 0 20 20" aria-hidden="true">${playIcon}</svg>
              <span>Play</span>
            </button>
          </div>
        </figcaption>
      </figure>`;
      this.replaceChildren(template.content);
      this.figure = this.querySelector(".lc-figure");
      this.map = this.querySelector(".lc-map");
      this.routes = this.querySelector(".lc-routes");
      this.signal = this.querySelector(".lc-signal");
      this.signalRing = this.querySelector(".lc-signal-ring");
      this.tracks = createTracks(this.routes);
      this.routes.append(this.signalRing, this.signal);
      this.nodes = [...this.querySelectorAll(".lc-node")];
      this.art = this.nodes.map(node => node.querySelector(".lc-art"));
      this.buttons = [...this.querySelectorAll(".lc-steps button")];
      this.caption = this.querySelector(".lc-caption");
      this.resultRows = [...this.querySelectorAll(".lc-result-row")];
      this.playButton = this.querySelector(".lc-play");
      this.playButton.addEventListener("click", () => {
        if (this.playing) this.pause();
        else this.play();
      });
      this.buttons.forEach((button, index) => {
        button.addEventListener("click", () => {
          this.pause();
          this.finished = false;
          this.showStage(index);
          this.render(0, false);
          this.updatePlayButton();
        });
      });
      this.querySelector(".lc-steps").addEventListener("keydown", this.focusStep);
      this.showStage(0);
    }

    onMotionChange = () => {
      if (this.motion.matches) {
        const focusWasOnPlay = document.activeElement === this.playButton;
        this.pause();
        this.elapsed = 0;
        this.inMotion = false;
        this.render(0, false);
        if (focusWasOnPlay) this.buttons[this.stage].focus();
      }
      this.playButton.hidden = this.motion.matches;
    };

    onVisibilityChange = () => {
      if (document.hidden) this.pause();
    };

    focusStep = (event) => {
      const index = this.buttons.indexOf(event.target);
      if (index === -1) return;
      const destinations = {
        ArrowLeft: Math.max(0, index - 1),
        ArrowRight: Math.min(this.buttons.length - 1, index + 1),
        Home: 0,
        End: this.buttons.length - 1,
      };
      const destination = destinations[event.key];
      if (destination === undefined) return;
      event.preventDefault();
      this.buttons[destination].focus();
    };

    layoutTracks() {
      const map = this.map.getBoundingClientRect();
      if (!map.width || !map.height) return;
      const boxes = this.art.map(art => {
        const box = art.getBoundingClientRect();
        return {
          x: box.left - map.left + box.width / 2,
          y: box.top - map.top + box.height / 2,
          width: box.width,
          height: box.height,
        };
      });
      const stacked = boxes[0].y < boxes[1].y - 1;
      this.routes.setAttribute("viewBox", `0 0 ${map.width} ${map.height}`);
      this.tracks.forEach(({ rail, trace, arrow }, index) => {
        const start = boxes[index];
        const end = boxes[index + 1];
        const direction = Math.sign(end.x - start.x);
        let d;
        if (stacked) {
          d = `M${start.x} ${start.y + start.height * .39} V${end.y - end.height * .39}`;
        } else if (index === 3) {
          const startX = start.x + start.width * .40;
          const elbow = (startX + map.width) / 2 + 2;
          const endX = end.x + end.width * .41;
          const radius = Math.min(12, (elbow - startX) * .7);
          d = `M${startX} ${start.y} H${elbow - radius}
            Q${elbow} ${start.y} ${elbow} ${start.y + radius}
            V${end.y - radius} Q${elbow} ${end.y} ${elbow - radius} ${end.y} H${endX}`;
        } else {
          d = `M${start.x + direction * start.width * .41} ${start.y}
            H${end.x - direction * end.width * .41}`;
        }
        rail.setAttribute("d", d);
        trace.setAttribute("d", d);
        const length = rail.getTotalLength();
        this.tracks[index].length = length;
        const tipAt = index === 3 && !stacked ? length - 22 : length * .55;
        const tip = rail.getPointAtLength(tipAt);
        const behind = rail.getPointAtLength(tipAt - 2);
        const rotation = Math.atan2(tip.y - behind.y, tip.x - behind.x) * 180 / Math.PI;
        arrow.setAttribute("d", "M-5 -3 L0 0 L-5 3");
        arrow.setAttribute("transform", `translate(${tip.x} ${tip.y}) rotate(${rotation})`);
      });
      this.render(this.elapsed, this.inMotion);
    }

    showStage(index) {
      this.stage = index;
      this.elapsed = 0;
      this.inMotion = false;
      this.nodes.forEach((node, position) => {
        node.dataset.state = position < index ? "complete" : position === index ? "current" : "pending";
      });
      this.tracks.forEach((track, position) => {
        track.arrow.classList.toggle("lc-arrow-complete", position < index);
      });
      this.buttons.forEach((button, position) => {
        if (position === index) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
      });
      this.caption.textContent = stages[index].description;
    }

    render(elapsed, inMotion) {
      const fraction = inMotion ? Math.min(1, elapsed / arrivalTime) : 1;
      const eased = fraction * fraction * (3 - 2 * fraction);
      const arriving = this.stage - 1;
      this.tracks.forEach(({ trace, length }, index) => {
        const fill = index < arriving ? 1 : index === arriving ? eased : 0;
        trace.style.visibility = fill ? "visible" : "hidden";
        trace.style.strokeDasharray = `${length} ${length}`;
        trace.style.strokeDashoffset = `${length * (1 - fill)}`;
      });

      const signalVisible = arriving >= 0 && inMotion && fraction < 1;
      if (signalVisible) {
        const track = this.tracks[arriving];
        const point = track.rail.getPointAtLength(track.length * eased);
        for (const dot of [this.signal, this.signalRing]) {
          dot.setAttribute("cx", point.x);
          dot.setAttribute("cy", point.y);
        }
      }
      for (const dot of [this.signal, this.signalRing]) {
        dot.setAttribute("visibility", signalVisible ? "visible" : "hidden");
      }

      const afterArrival = elapsed - arrivalTime;
      const scan = inMotion && this.stage === 2 ? clampUnit(afterArrival / 950) : 0;
      this.figure.style.setProperty("--lc-scan-offset", `${-34 * scan}px ${18 * scan}px`);
      this.figure.style.setProperty("--lc-scan-opacity", `${Math.sin(scan * Math.PI) * .88}`);

      const review = inMotion && this.stage === 4 ? clampUnit(afterArrival / 650) : 0;
      this.figure.style.setProperty("--lc-review-opacity", `${Math.sin(review * Math.PI) * .78}`);
      this.figure.style.setProperty("--lc-review-scale", `${.7 + review * .45}`);

      const counting = inMotion && this.stage === 5;
      this.nodes[5].toggleAttribute("data-counting", counting);
      this.resultRows.forEach((row, index) => {
        const fill = counting ? clampUnit((afterArrival - index * 105) / 435) : 0;
        row.style.strokeDashoffset = 1 - fill;
      });
    }

    play() {
      if (this.motion.matches) return;
      this.caption.setAttribute("aria-live", "off");
      if (this.finished || (this.stage === stages.length - 1 && this.elapsed === 0)) {
        this.showStage(0);
      }
      this.finished = false;
      this.playing = true;
      this.inMotion = true;
      this.figure.dataset.playing = "";
      this.startedAt = performance.now() - this.elapsed;
      this.updatePlayButton();
      this.frame = requestAnimationFrame(this.tick);
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      cancelAnimationFrame(this.frame);
      delete this.figure.dataset.playing;
      this.caption.setAttribute("aria-live", "polite");
      this.updatePlayButton();
    }

    tick = (now) => {
      this.elapsed = now - this.startedAt;
      while (this.elapsed >= stages[this.stage].duration) {
        if (this.stage === stages.length - 1) {
          this.finished = true;
          this.inMotion = false;
          this.render(0, false);
          this.pause();
          return;
        }
        this.startedAt += stages[this.stage].duration;
        this.showStage(this.stage + 1);
        this.inMotion = true;
        this.elapsed = now - this.startedAt;
      }
      this.render(this.elapsed, true);
      this.frame = requestAnimationFrame(this.tick);
    };

    updatePlayButton() {
      const replay = this.finished || (this.stage === stages.length - 1 && this.elapsed === 0);
      const action = this.playing ? ["Pause", pauseIcon] : replay ? ["Replay", replayIcon] : ["Play", playIcon];
      this.playButton.setAttribute("aria-label", `${action[0]} the connection animation`);
      this.playButton.querySelector("span").textContent = action[0];
      this.playButton.querySelector("svg").innerHTML = action[1];
    }
  }

  if (!customElements.get("loci-connection")) {
    customElements.define("loci-connection", LociConnection);
  }
})();
