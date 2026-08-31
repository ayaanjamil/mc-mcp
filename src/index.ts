#!/usr/bin/env node
import { MoodleMcpServer } from './server.js';

const server = new MoodleMcpServer();
server.run().catch(console.error);
