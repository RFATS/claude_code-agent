// MCP 클라이언트 — real-estate-mcp(tae0y)를 stdio 로 띄워 툴을 호출한다. LLM 은 관여하지 않는다.
// 장수 프로세스 1개를 재사용하고, 연결이 끊기면 다음 호출에서 다시 연결한다.
"use strict";

class McpClient {
  // stderr: 'ignore' 가 기본. real-estate-mcp 는 요청 URL(serviceKey 포함)을 stderr 로그에 남기므로
  // 'inherit' 로 두면 터미널·로그에 API 키가 그대로 찍힌다. 디버깅할 때만 MCP_STDERR=inherit 로 켠다.
  constructor({ dir, apiKey, command = "uv", connectTimeoutMs = 180000, callTimeoutMs = 120000, stderr = process.env.MCP_STDERR || "ignore" }) {
    if (!dir) throw new Error("MCP_DIR 이 필요합니다 (real-estate-mcp 저장소 경로).");
    if (!apiKey) throw new Error("DATA_GO_KR_API_KEY 가 필요합니다.");
    this.dir = dir;
    this.apiKey = apiKey;
    this.command = command;
    this.connectTimeoutMs = connectTimeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.stderr = stderr;
    this.client = null;
    this.transport = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport, getDefaultEnvironment } = require("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: this.command,
        args: ["run", "--directory", this.dir, "real-estate-mcp"],
        // SDK 는 env 를 화이트리스트만 상속하므로 기본 환경에 키를 명시 병합한다.
        env: { ...getDefaultEnvironment(), DATA_GO_KR_API_KEY: this.apiKey, PYTHONUTF8: "1" },
        stderr: this.stderr,
      });
      const client = new Client({ name: "tier-inversion", version: "0.1.0" });
      transport.onclose = () => {
        if (this.transport === transport) {
          this.client = null;
          this.transport = null;
        }
      };
      // 첫 실행은 .venv·Python 내려받기 때문에 오래 걸릴 수 있다.
      await client.connect(transport, { timeout: this.connectTimeoutMs });
      this.client = client;
      this.transport = transport;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  // 툴 호출 → 파싱된 객체. 서버가 isError 로 답하면(입력 검증 실패 등) 예외.
  async callTool(name, args) {
    const client = await this.connect();
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: this.callTimeoutMs });
    const text = res.content && res.content[0] && res.content[0].type === "text" ? res.content[0].text : "";
    if (res.isError) throw new Error(`MCP 툴 오류(${name}): ${text.slice(0, 300)}`);
    if (res.structuredContent) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`MCP 응답을 JSON 으로 해석할 수 없습니다(${name}): ${text.slice(0, 120)}`);
    }
  }

  async listTools() {
    const client = await this.connect();
    return (await client.listTools()).tools;
  }

  async close() {
    const t = this.transport;
    this.client = null;
    this.transport = null;
    if (t) await t.close().catch(() => {});
  }
}

module.exports = { McpClient };
