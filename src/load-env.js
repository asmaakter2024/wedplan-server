/** Load the server's .env regardless of the directory used to start Node. */
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const serverEnvPath = fileURLToPath(new URL("../.env", import.meta.url));
dotenv.config({ path: serverEnvPath });
