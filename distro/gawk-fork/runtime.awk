# SPDX-License-Identifier: MIT

function fail(message) {
  failed = 1
  printf("gawk-fork runtime: %s\n", message) > "/dev/stderr"
  exit 1
}

function check_file(path, expected, line, status, extra) {
  status = (getline line < path)
  if (status != 1 || line != expected) {
    close(path)
    fail("file content mismatch: " path)
  }
  status = (getline extra < path)
  close(path)
  if (status != 0)
    fail("file has unexpected extra content: " path)
}

BEGIN {
  failed = 0

  system_status = system("printf 'system-content\\n' > " workdir "/system.txt")
  if (system_status != 0)
    fail("system() did not return success")
  check_file(workdir "/system.txt", "system-content")
  print "gawk-fork: system status and output content ok"

  write_command = "cat > " workdir "/write-pipe.txt"
  print "write-pipe-content" | write_command
  flush_status = fflush(write_command)
  close_status = close(write_command)
  if (flush_status != 0 || close_status != 0)
    fail("write pipe fflush/close returned an error")
  check_file(workdir "/write-pipe.txt", "write-pipe-content")
  print "gawk-fork: write pipe fflush/close content ok"

  read_command = "printf 'read-first\\nread-second\\n'"
  if ((read_command | getline line) != 1 || line != "read-first")
    fail("command getline returned the wrong first line")
  if ((read_command | getline line) != 1 || line != "read-second")
    fail("command getline returned the wrong second line")
  if ((read_command | getline line) != 0)
    fail("command getline did not report EOF")
  if (close(read_command) != 0)
    fail("close after command getline returned an error")

  if ((read_command | getline line) != 1 || line != "read-first")
    fail("reopened command pipe did not restart its output")
  if ((read_command | getline line) != 1 || line != "read-second")
    fail("reopened command pipe returned the wrong second line")
  if ((read_command | getline line) != 0)
    fail("reopened command pipe did not report EOF")
  if (close(read_command) != 0)
    fail("close after reopened command getline returned an error")
  print "gawk-fork: command getline close/reopen content and status ok"

  coprocess = "awk '{ print toupper($0); fflush() }'"
  print "coprocess-content" |& coprocess
  if (fflush(coprocess) != 0)
    fail("coprocess fflush returned an error")
  if ((coprocess |& getline line) != 1 || line != "COPROCESS-CONTENT")
    fail("coprocess returned the wrong response")
  if (close(coprocess, "to") != 0)
    fail("closing coprocess input returned an error")
  if ((coprocess |& getline line) != 0)
    fail("coprocess did not report EOF after input close")
  if (close(coprocess, "from") != 0)
    fail("closing coprocess output returned an error")
  print "gawk-fork: coprocess fflush/close and response content ok"

  failure_status = system("exit 7")
  if (failure_status != 7)
    fail("system() did not preserve the failing child status")
  recovery_status = system("printf 'recovered-content\\n' > " workdir "/recovered.txt")
  if (recovery_status != 0)
    fail("child execution did not recover after a failing command")
  check_file(workdir "/recovered.txt", "recovered-content")
  print "gawk-fork: failed child status and subsequent recovery ok"
}

{
  if (NR == 1 && $0 != "stdin-first")
    fail("standard input first line did not match")
  if (NR == 2 && $0 != "stdin-second")
    fail("standard input second line did not match")
  if (NR > 2)
    fail("standard input had an unexpected extra line")
}

END {
  if (failed)
    exit 1
  if (NR != 2)
    fail("standard input did not contain exactly two lines")
  print "gawk-fork: standard input and output content ok"
}
