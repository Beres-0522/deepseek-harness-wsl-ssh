import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createDeepSeekHarnessServer } from "./src/server.mjs";

const server = await createDeepSeekHarnessServer();
await server.connect(new StdioServerTransport());
