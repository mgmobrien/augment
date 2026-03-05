//go:build !windows
// +build !windows

package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/creack/pty"
	"golang.org/x/term"
)

func main() {
	shell := os.Getenv("AUGMENT_SHELL")
	if shell == "" {
		shell = "bash"
	}

	shellParts := strings.Fields(shell)
	shellBin := shell
	shellArgs := []string{}
	if len(shellParts) > 0 {
		shellBin = shellParts[0]
		shellArgs = append(shellArgs, shellParts[1:]...)
	}

	// Run common shells in interactive mode by default so they don't
	// auto-exit in PTY contexts where shell startup differs from a normal TTY.
	base := filepath.Base(shellBin)
	if len(shellArgs) == 0 && (base == "bash" || base == "zsh" || base == "sh" || base == "fish") {
		shellArgs = append(shellArgs, "-i")
	}

	c := exec.Command(shellBin, shellArgs...)
	cwd := os.Getenv("AUGMENT_CWD")
	if cwd != "" {
		c.Dir = cwd
	}

	ptmx, err := pty.Start(c)
	if err != nil {
		log.Fatalf("Failed to spawn pty: %v", err)
	}
	defer ptmx.Close()

	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err == nil {
		defer term.Restore(int(os.Stdin.Fd()), oldState)
	}

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
				_ = pty.Setsize(ptmx, &pty.Winsize{
					Rows: uint16(rows),
					Cols: uint16(cols),
				})
			}
		}
	}()

	go io.Copy(ptmx, os.Stdin)
	go io.Copy(os.Stdout, ptmx)

	if err := c.Wait(); err != nil {
		if exiterr, ok := err.(*exec.ExitError); ok {
			os.Exit(exiterr.ExitCode())
		}
		os.Exit(1)
	}
	os.Exit(0)
}
