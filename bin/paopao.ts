#!/usr/bin/env node
import { createCli } from '../src/cli.js'

createCli().parse(process.argv)
