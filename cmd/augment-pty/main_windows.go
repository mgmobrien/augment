package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"github.com/UserExistsError/conpty"
)

func main() {
	shell := os.Getenv("AUGMENT_SHELL")
	if shell == "" {
		shell = "cmd.exe"
	}

	// Use initial dimensions from environment if available, otherwise
	// default to 80x24. This avoids the race where the shell/TUI starts
	// painting at the wrong size before the Node side sends a resize.
	initRows, initCols := 24, 80
	if v := os.Getenv("AUGMENT_ROWS"); v != "" {
		fmt.Sscanf(v, "%d", &initRows)
	}
	if v := os.Getenv("AUGMENT_COLS"); v != "" {
		fmt.Sscanf(v, "%d", &initCols)
	}
	cpty, err := conpty.Start(shell,
		conpty.ConPtyWorkDir(os.Getenv("AUGMENT_CWD")),
		conpty.ConPtyDimensions(initCols, initRows),
	)
	if err != nil {
		log.Fatalf("Failed to spawn a pty: %v", err)
	}
	defer cpty.Close()

	go func() {
		resizeFile := os.NewFile(3, "resize_pipe")
		reader := bufio.NewReader(resizeFile)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			var rows, cols int
			if _, err := fmt.Sscanf(strings.TrimSpace(line), "R%d,%d", &rows, &cols); err == nil {
				cpty.Resize(cols, rows)
			}
		}
	}()

	go io.Copy(cpty, os.Stdin)

	// Drain ConPTY output before exiting. After the child exits,
	// io.Copy will read remaining buffered data then get EOF.
	done := make(chan struct{})
	go func() {
		io.Copy(os.Stdout, cpty)
		close(done)
	}()

	exitCode, _ := cpty.Wait(context.Background())
	<-done // wait for all output to be forwarded
	os.Exit(int(exitCode))
}
