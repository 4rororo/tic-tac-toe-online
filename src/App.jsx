import React, { useEffect, useMemo, useRef, useState } from "react";
// Online: PeerJS for easy WebRTC data connections
import Peer from "peerjs";

// ===== Utility helpers =====
const hashRoom = async (playerName, password) => {
  const enc = new TextEncoder();
  const data = enc.encode(`${playerName}::${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
};

const cellAt = (idx, n) => ({ r: Math.floor(idx / n), c: idx % n });
const idxAt = (r, c, n) => r * n + c;

// Check win: n-in-a-row for size n
function checkWin(board, n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push([...Array(n)].map((_, j) => idxAt(i, j, n))); // row
    lines.push([...Array(n)].map((_, j) => idxAt(j, i, n))); // col
  }
  lines.push([...Array(n)].map((_, j) => idxAt(j, j, n))); // diag
  lines.push([...Array(n)].map((_, j) => idxAt(j, n - 1 - j, n))); // anti
  for (const line of lines) {
    const first = board[line[0]];
    if (!first) continue;
    const ok = line.every((i) => board[i] && board[i].player === first.player);
    if (ok) return { winner: first.player, line };
  }
  return null;
}

// Draw to canvas
function drawBoard(ctx, state) {
  const { n, board, win, theme } = state;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);

  // background
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);

  const pad = 20;
  const size = Math.min(W, H) - pad * 2;
  const left = (W - size) / 2;
  const top = (H - size) / 2;
  const cell = size / n;

  // grid
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 2;
  for (let i = 1; i < n; i++) {
    const x = left + i * cell;
    const y = top + i * cell;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + size, y);
    ctx.stroke();
  }

  // pieces
  for (let i = 0; i < n * n; i++) {
    const piece = board[i];
    if (!piece) continue;
    const { r, c } = cellAt(i, n);
    const cx = left + c * cell + cell / 2;
    const cy = top + r * cell + cell / 2;
    const rad = Math.min(cell * 0.35, 48);

    // base circle
    ctx.beginPath();
    ctx.fillStyle = piece.player === 1 ? theme.p1 : theme.p2;
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();

    // label
    ctx.fillStyle = theme.label;
    ctx.font = `${Math.floor(rad)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(piece.label.toString(), cx, cy + 1);
  }

  // win highlight
  if (win) {
    const { line, winner } = win;
    const first = cellAt(line[0], n);
    const last = cellAt(line[line.length - 1], n);
    const start = {
      x: left + first.c * cell + cell / 2,
      y: top + first.r * cell + cell / 2,
    };
    const end = {
      x: left + last.c * cell + cell / 2,
      y: top + last.r * cell + cell / 2,
    };
    ctx.strokeStyle = winner === 1 ? theme.p1Strong : theme.p2Strong;
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  return { left, top, cell, size };
}

// ===== Main Component =====
export default function TicTacToeCanvasOnline() {
  const canvasRef = useRef(null);
  const [n, setN] = useState(3);
  const maxPieces = n; // 3 for 3x3, 4 for 4x4
  const [board, setBoard] = useState(Array(9).fill(null));
  const [turn, setTurn] = useState(1); // 1 or 2
  const [queues, setQueues] = useState({ 1: [], 2: [] }); // oldest first
  const [nextLabel, setNextLabel] = useState({ 1: 1, 2: 1 }); // cycles 1..n
  const [win, setWin] = useState(null);

  // UI theme
  const theme = useMemo(
    () => ({
      bg: "#0b1220",
      grid: "#2b3b63",
      label: "#ffffff",
      p1: "#4f9cf9",
      p2: "#f97393",
      p1Strong: "#1e78f0",
      p2Strong: "#ff3b6b",
    }),
    []
  );

  // Online state
  const [mode, setMode] = useState("local"); // local | online
  const [role, setRole] = useState(null); // host | guest
  const [playerName, setPlayerName] = useState("");
  const [password, setPassword] = useState("");
  const [roomId, setRoomId] = useState("");
  const peerRef = useRef(null);
  const connRef = useRef(null); // data connection
  const [netStatus, setNetStatus] = useState("未接続");
  const [iAm, setIAm] = useState(1); // my player number in online: host=1, guest=2

  // Resize board when n changes
  useEffect(() => {
    if (n === 3) setBoard(Array(9).fill(null));
    else setBoard(Array(16).fill(null));
    setQueues({ 1: [], 2: [] });
    setNextLabel({ 1: 1, 2: 1 });
    setTurn(1);
    setWin(null);
  }, [n]);

  // Canvas resize & draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    drawBoard(ctx, { n, board, win, theme });
  }, [n, board, win, theme]);

  // Handle clicks
  const onCanvasClick = async (e) => {
    if (win) return; // game ended
    // Online: enforce turn ownership
    if (mode === "online" && turn !== iAm) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // map to cell
    const ctx = canvas.getContext("2d");
    const info = drawBoard(ctx, { n, board, win, theme });
    const { left, top, cell, size } = info;
    if (
      x < left ||
      x > left + size ||
      y < top ||
      y > top + size
    )
      return;
    const c = Math.floor((x - left) / cell);
    const r = Math.floor((y - top) / cell);
    const index = idxAt(r, c, n);

    if (board[index]) return; // occupied

    if (mode === "online" && role === "guest") {
      // Send attempt to host; host is authoritative
      connRef.current?.send({ type: "attempt", index });
      return;
    }

    // Local or Host applying move
    applyMove(index, turn);
    if (mode === "online" && role === "host") {
      broadcastState();
    }
  };

  function cycleLabelFor(player) {
    const label = nextLabel[player];
    const next = label >= n ? 1 : label + 1;
    setNextLabel((prev) => ({ ...prev, [player]: next }));
    return label;
  }

  function removeOldestIfNeeded(forPlayer, b, q) {
    const qArr = [...q[forPlayer]];
    if (qArr.length >= maxPieces) {
      const idx = qArr.shift();
      b[idx] = null;
    }
    return qArr; // possibly shortened
  }

  function applyMove(index, player) {
    setBoard((prev) => {
      const b = [...prev];
      const queuesCopy = { 1: [...queues[1]], 2: [...queues[2]] };
      // remove oldest if needed
      const qArr = removeOldestIfNeeded(player, b, queues);
      // place new piece
      const label = cycleLabelFor(player);
      b[index] = { player, label };
      const newQ = { ...queuesCopy, [player]: [...qArr, index] };
      setQueues(newQ);

      // win?
      const res = checkWin(b, n);
      setWin(res);

      // next turn
      if (!res) setTurn(player === 1 ? 2 : 1);

      return b;
    });
  }

  // Online helpers
  async function prepareRoomId(name, pass) {
    const h = await hashRoom(name.trim(), pass.trim());
    return `room-${h.slice(0, 12)}-host`;
  }

  async function createRoom() {
    setMode("online");
    setRole("host");
    const rid = await prepareRoomId(playerName || "player", password || "");
    setRoomId(rid);
    const peer = new Peer(rid);
    peerRef.current = peer;
    setIAm(1);
    setNetStatus("待機中（相手接続待ち）");

    peer.on("connection", (conn) => {
      connRef.current = conn;
      setNetStatus("接続中");
      // Send initial state
      conn.on("data", (data) => {
        if (data?.type === "attempt") {
          // guest attempted a move; host validates & applies
          if (turn !== 2 || win) return; // only guest's turn
          const idx = data.index;
          if (typeof idx === "number" && !board[idx]) {
            applyMove(idx, 2);
            // After state updates, schedule broadcast
            setTimeout(() => broadcastState(), 0);
          }
        } else if (data?.type === "sync_request") {
          broadcastState();
        } else if (data?.type === "chat") {
          // ignore for now
        }
      });
      // greet
      broadcastState();
    });

    peer.on("error", (err) => {
      console.error(err);
      setNetStatus(`エラー: ${err.type || err.message}`);
    });
  }

  async function joinRoom() {
    setMode("online");
    setRole("guest");
    const rid = await prepareRoomId(playerName || "player", password || "");
    setRoomId(rid);
    const peer = new Peer();
    peerRef.current = peer;
    setIAm(2);

    peer.on("open", () => {
      const conn = peer.connect(rid);
      connRef.current = conn;
      setNetStatus("接続試行中");

      conn.on("open", () => {
        setNetStatus("接続中");
        conn.send({ type: "sync_request" });
      });

      conn.on("data", (data) => {
        if (data?.type === "state") {
          // apply authoritative state from host
          hydrateFromState(data.payload);
        }
      });

      conn.on("close", () => setNetStatus("切断"));
      conn.on("error", (e) => setNetStatus(`エラー: ${e.type || e.message}`));
    });

    peer.on("error", (err) => setNetStatus(`エラー: ${err.type || err.message}`));
  }

  function snapshotState() {
    return { n, board, turn, queues, nextLabel, win };
  }

  function hydrateFromState(s) {
    if (!s) return;
    setN(s.n);
    setBoard(s.board);
    setTurn(s.turn);
    setQueues(s.queues);
    setNextLabel(s.nextLabel);
    setWin(s.win);
  }

  function broadcastState() {
    const conn = connRef.current;
    if (!conn || conn.open !== true) return;
    const payload = snapshotState();
    conn.send({ type: "state", payload });
  }

  function resetGame() {
    setBoard(Array(n * n).fill(null));
    setQueues({ 1: [], 2: [] });
    setNextLabel({ 1: 1, 2: 1 });
    setTurn(1);
    setWin(null);
    if (mode === "online" && role === "host") broadcastState();
  }

  // Cleanup peers on unmount
  useEffect(() => {
    return () => {
      try { connRef.current?.close(); } catch {}
      try { peerRef.current?.destroy(); } catch {}
    };
  }, []);

  // UI derived
  const statusText = useMemo(() => {
    if (win) return `勝者: プレイヤー${win.winner}`;
    return `手番: プレイヤー${turn}`;
  }, [win, turn]);

  // Remaining pieces
  const remainP1 = Math.max(0, maxPieces - queues[1].length);
  const remainP2 = Math.max(0, maxPieces - queues[2].length);

  return (
    <div className="min-h-screen w-full bg-slate-900 text-slate-100 flex flex-col items-center p-4 gap-4">
      <header className="w-full max-w-4xl flex flex-col md:flex-row items-center justify-between gap-3">
        <h1 className="text-2xl md:text-3xl font-bold">Canvas 〇✕ゲーム（番号付き・オンライン対応）</h1>
        <div className="flex items-center gap-2">
          <button
            className={`px-3 py-2 rounded-2xl shadow ${n===3?"bg-blue-500":"bg-slate-700"}`}
            onClick={() => setN(3)}
            disabled={mode==="online" && role!=="host"}
            title={mode==="online" && role!=="host"?"オンライン中はホストのみ変更可":"3x3に切替"}
          >3×3</button>
          <button
            className={`px-3 py-2 rounded-2xl shadow ${n===4?"bg-blue-500":"bg-slate-700"}`}
            onClick={() => setN(4)}
            disabled={mode==="online" && role!=="host"}
            title={mode==="online" && role!=="host"?"オンライン中はホストのみ変更可":"4x4に切替"}
          >4×4</button>
          <button
            className="px-3 py-2 rounded-2xl shadow bg-emerald-600 hover:bg-emerald-500"
            onClick={resetGame}
          >リセット</button>
        </div>
      </header>

      <div className="w-full max-w-4xl grid md:grid-cols-3 gap-4">
        {/* Left: Canvas */}
        <div className="md:col-span-2 bg-slate-800 rounded-2xl shadow p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">{statusText}</div>
            <div className="text-sm opacity-80">{mode === "online" ? `ネットワーク: ${netStatus}` : "ローカル対戦"}</div>
          </div>
          <div className="relative w-full aspect-square">
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full cursor-pointer rounded-2xl"
              onClick={onCanvasClick}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="bg-slate-700 rounded-xl p-2 flex items-center justify-between">
              <div>プレイヤー1 残り: {remainP1}/{maxPieces}</div>
              <div className="flex gap-1">
                {Array.from({ length: maxPieces }, (_, i) => (
                  <span key={i} className={`w-7 h-7 rounded-full grid place-items-center ${i < queues[1].length ? "bg-blue-500" : "bg-slate-600"}`}>{(i<maxPieces)?(i+1):""}</span>
                ))}
              </div>
            </div>
            <div className="bg-slate-700 rounded-xl p-2 flex items-center justify-between">
              <div>プレイヤー2 残り: {remainP2}/{maxPieces}</div>
              <div className="flex gap-1">
                {Array.from({ length: maxPieces }, (_, i) => (
                  <span key={i} className={`w-7 h-7 rounded-full grid place-items-center ${i < queues[2].length ? "bg-pink-500" : "bg-slate-600"}`}>{(i<maxPieces)?(i+1):""}</span>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs opacity-75">※ 盤面が満杯の時に新しいピースを置くと、そのプレイヤーの最も古いピースが自動で取り除かれます（固有ピースの入れ替え）。</p>
        </div>

        {/* Right: Online controls */}
        <div className="bg-slate-800 rounded-2xl shadow p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm px-2 py-1 rounded-full bg-slate-700">対戦モード</span>
            <div className="flex gap-2">
              <button
                className={`px-3 py-1 rounded-2xl ${mode==="local"?"bg-blue-500":"bg-slate-700"}`}
                onClick={() => { setMode("local"); setRole(null); setNetStatus("未接続"); try{peerRef.current?.destroy();}catch{} }}
              >ローカル</button>
              <button
                className={`px-3 py-1 rounded-2xl ${mode==="online"?"bg-blue-500":"bg-slate-700"}`}
                onClick={() => setMode("online")}
              >オンライン</button>
            </div>
          </div>

          <div className="grid gap-2">
            <label className="text-sm">プレイヤー名</label>
            <input className="px-3 py-2 rounded-xl bg-slate-700 outline-none" value={playerName} onChange={(e)=>setPlayerName(e.target.value)} placeholder="例: Kota"/>
            <label className="text-sm">パスワード（部屋の鍵）</label>
            <input className="px-3 py-2 rounded-xl bg-slate-700 outline-none" value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="8文字以上を推奨" type="password"/>
            <div className="flex gap-2">
              <button className="px-3 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60" onClick={createRoom} disabled={!playerName || !password}>部屋を作成（ホスト）</button>
              <button className="px-3 py-2 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60" onClick={joinRoom} disabled={!playerName || !password}>部屋に参加（ゲスト）</button>
            </div>
            {roomId && (
              <div className="text-xs break-all opacity-70">RoomID: {roomId}</div>
            )}
            <div className="text-xs opacity-80">ホスト＝プレイヤー1、ゲスト＝プレイヤー2。手番は交互です。</div>
          </div>

          <div className="mt-2 text-sm">
            <div className="font-semibold mb-1">操作</div>
            <ul className="list-disc pl-5 space-y-1 opacity-90">
              <li>盤面をクリックして自分の番にピースを置く</li>
              <li>ピースは各プレイヤー：3x3で1～3、4x4で1～4の数字が順番に割り当て</li>
              <li>同じマスには置けません</li>
              <li>勝利ラインは太線で強調表示</li>
            </ul>
          </div>
        </div>
      </div>

      <footer className="text-xs opacity-60 mt-2">
        WebRTC(PeerJS)を用いたP2P接続。プレイヤー名とパスワードの組合せから部屋IDを生成します。
      </footer>
    </div>
  );
}
