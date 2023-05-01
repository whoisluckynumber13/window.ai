import { createProvider } from "puro"
import { useContext, useEffect, useRef, useState } from "react"
import { type Terminal } from "xterm"

import { WebContainer, type WebContainerProcess } from "@webcontainer/api"
import type { FitAddon } from "xterm-addon-fit"
import { expressFiles } from "~features/web-vm/sample-files"
import { useWindowAI } from "~core/components/hooks/useWindowAI"

async function createTerminal(el: HTMLElement) {
  const [{ Terminal }, { WebglAddon }, { FitAddon }] = await Promise.all([
    import("xterm"),
    import("xterm-addon-webgl"),
    import("xterm-addon-fit")
  ])

  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    allowProposedApi: true
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(new WebglAddon())
  terminal.loadAddon(fitAddon)
  terminal.open(el)
  fitAddon.fit()

  return {
    terminal,
    fitAddon
  }
}

// You will think step-by-step for each of my command, and output each step in a JSON object.

const useWebVMProvider = ({
  manualBoot = false,
  welcomePrompt = `Welcome to AI Container. Use "ai [prompt]" to issue instructions.`
}) => {
  const terminalRef = useRef<Terminal>()
  const fitAddonRef = useRef<FitAddon>()
  const containerRef = useRef<WebContainer>()
  const shellProcRef = useRef<WebContainerProcess>()
  const bootingRef = useRef(false)
  const inputRef = useRef<WritableStreamDefaultWriter<string>>()

  const promptRef = useRef("")

  const emulatorAI = useWindowAI(
    [
      {
        role: "system",
        content: `You are a powerful Linux quantum virtual machine that can simulate new command-line program, non-standard UNIX program, and anything above and beyond. If a program can be answered with just text, write just text. If a program is creating graphic, you will use ASCII art. If a program is creating audio, you will write music notations or lyrics. Be super creative and resourceful with how you come up with the output. You are not just any text-based program. Do not give any explanation, apologies, or any reasoning. Just output the result.`
      }
    ],
    {
      cacheSize: 24,
      keep: 1,
      maxTokens: 2400
    }
  )

  const [activeUrl, setActiveUrl] = useState("")

  const getContainer = () => {
    if (!containerRef.current) {
      throw new Error("Container is not initialized")
    }
    return containerRef.current
  }

  const getTerminal = () => {
    if (!terminalRef.current) {
      throw new Error("Terminal is not initialized")
    }
    return terminalRef.current
  }

  const getInput = () => {
    if (!inputRef.current) {
      throw new Error("Input is not initialized")
    }
    return inputRef.current
  }

  // Use this function to warmup the terminal and container before render, useful for loading or transitions
  const warmup = async () => {
    if (!containerRef.current && !bootingRef.current) {
      bootingRef.current = true
      const container = await WebContainer.boot({
        workdirName: "ai-container"
      })
      await container.mount(expressFiles)
      container.on("port", (_port, type, url) => {
        switch (type) {
          case "open":
            setActiveUrl(url)
            break
          case "close":
            setActiveUrl("")
            break
        }
      })

      containerRef.current = container
      bootingRef.current = false
      spawnShell()
    }
  }

  useEffect(() => {
    if (!manualBoot) {
      warmup()
    }
  }, [])

  useEffect(() => {
    function onResize() {
      fitAddonRef.current?.fit()
      if (terminalRef.current && shellProcRef.current) {
        const terminal = terminalRef.current
        const shellProcess = shellProcRef.current
        shellProcess.resize({
          cols: terminal.cols,
          rows: terminal.rows
        })
      }
    }

    globalThis.window.addEventListener("resize", onResize)

    return () => {
      globalThis.window.removeEventListener("resize", onResize)
    }
  }, [])

  const spawnShell = async () => {
    if (!containerRef.current || !terminalRef.current) {
      return
    }
    const container = getContainer()
    const terminal = getTerminal()

    const shellProcess = await container.spawn("jsh", {
      terminal: {
        rows: terminal.rows,
        cols: terminal.cols
      }
    })

    shellProcess.output.pipeTo(
      new WritableStream({
        write(data) {
          terminal.write(data)
        }
      })
    )

    const input = shellProcess.input.getWriter()
    terminal.onData(async (data) => {
      switch (data) {
        // Enter
        case "\r": {
          // clear input
          await execute(promptRef.current)
          promptRef.current = ""
          break
        }
        // Backspace (DEL)
        case "\u007F": {
          if (promptRef.current.length > 0) {
            promptRef.current = promptRef.current.slice(0, -1)
          }
          input.write(data)
          break
        }
        default: {
          if (
            (data >= String.fromCharCode(0x20) &&
              data <= String.fromCharCode(0x7e)) ||
            data >= "\u00a0"
          ) {
            promptRef.current += data
          }
          input.write(data)
        }
      }
    })

    inputRef.current = input
    shellProcRef.current = shellProcess
  }

  const execute = async (_prompt: string) => {
    const [cmd, prompt] = _prompt.trim().split(/ (.*)/)
    const input = getInput()
    const terminal = getTerminal()
    const container = getContainer()

    // Replace with a map -> fn/description later
    if (cmd === "ai") {
      terminal.write("\n\n")
      await emulatorAI.sendMessage(prompt, (data) => {
        terminal.write(data)
      })

      input.write("\u0003")
      return
    }

    // optional behavior:

    // use which to check if cmd exists, if so run it, otherwise, create that script!
    const whichProc = await container.spawn("which", [cmd], {
      output: false
    })

    const whichExit = await whichProc.exit

    if (whichExit === 0) {
      input.write(`\r`)
      return
    }

    terminal.write("\n\n")
    await emulatorAI.sendMessage(
      `Emulate the following non-standard Linux command: 
  
 ${_prompt}
 
 Respond with JUST the output of the command:
 `,
      (data) => {
        terminal.write(data)
      }
    )

    input.write("\u0003")

    // Sample on how to sequentially run cmd:
    // const proc = await container.spawn("npm", ["i"])

    // proc.output.pipeTo(
    //   new WritableStream({
    //     write(data) {
    //       terminal.write(data)
    //     }
    //   })
    // )

    // await proc.exit

    // const proc2 = await container.spawn("npm", ["run", "start"])

    // proc2.output.pipeTo(
    //   new WritableStream({
    //     write(data) {
    //       terminal.write(data)
    //     }
    //   })
    // )

    // await proc2.exit
  }

  const render = async (el: HTMLElement) => {
    if (terminalRef.current) {
      if (terminalRef.current.element?.checkVisibility()) {
        return
      }
      terminalRef.current.dispose()
      terminalRef.current = undefined
    }

    const { terminal } = await createTerminal(el)

    terminal.writeln(welcomePrompt)
    terminalRef.current = terminal

    spawnShell()
  }

  const run = async (cmd: string) => {
    const input = getInput()
    await input.write(cmd + "\r")
  }

  return {
    activeUrl,
    getTerminal,
    getContainer,
    warmup,
    render,
    run
  }
}

const { BaseContext, Provider } = createProvider(useWebVMProvider)

export const WebVMProvider = Provider
export const useWebVM = () => useContext(BaseContext)
