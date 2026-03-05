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

	cpty, err := conpty.Start(shell, conpty.ConPtyWorkDir(os.Getenv("AUGMENT_CWD")))
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
	go io.Copy(os.Stdout, cpty)

	exitCode, _ := cpty.Wait(context.Background())
	os.Exit(int(exitCode))
}
