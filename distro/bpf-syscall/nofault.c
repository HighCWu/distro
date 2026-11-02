/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only in an isolated Linux/Wasm image"
#endif
#include <errno.h>
#include <fcntl.h>
#include <linux/bpf.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

struct result { char text[32]; int32_t status; uint32_t invalid; unsigned char tail[24]; };
_Static_assert(sizeof(struct result) == 64 && offsetof(struct result, status) == 32 &&
               offsetof(struct result, invalid) == 36, "BPF map value ABI");
static char verifier_log[16384];
static void require(int condition, const char *message)
{
    if (!condition) {
        fprintf(stderr, "::vm-test::fail: bpf nofault: %s errno=%d\n", message, errno);
        exit(1);
    }
}
static uint64_t pointer(const void *p) { return (uint64_t)(uintptr_t)p; }
static long command(int operation, union bpf_attr *attr)
{
    return syscall(SYS_bpf, (long)operation, attr, (long)sizeof(*attr));
}
static int map(unsigned size, unsigned flags)
{
    union bpf_attr attr = {.map_type=BPF_MAP_TYPE_ARRAY,.key_size=4,
        .value_size=size,.max_entries=1,.map_flags=flags};
    int fd = command(BPF_MAP_CREATE, &attr);
    require(fd >= 0, "create map");
    return fd;
}
static void update(int fd, const void *value)
{
    uint32_t key = 0;
    union bpf_attr attr = {.map_fd=(uint32_t)fd,.key=pointer(&key),.value=pointer(value),.flags=BPF_ANY};
    require(!command(BPF_MAP_UPDATE_ELEM, &attr), "update map");
}
static void lookup(int fd, struct result *out)
{
    uint32_t key = 0;
    union bpf_attr attr = {.map_fd=(uint32_t)fd,.key=pointer(&key),.value=pointer(out)};
    require(!command(BPF_MAP_LOOKUP_ELEM, &attr), "lookup result");
}
static int load(int output, int format)
{
    /* This original test bytecode also offers a GPL-2.0-only option, allowing
     * the standard GPL-only helper. The MIT option and C loader stay available.
     * All pointers passed to the helper are kernel map/stack addresses; the
     * deliberately unsafe formatting argument is never a user memory alias.
     */
    struct bpf_insn program[] = {
        {.code=BPF_LD|BPF_DW|BPF_IMM,.dst_reg=BPF_REG_1,.src_reg=BPF_PSEUDO_MAP_FD,.imm=output}, {0},
        {.code=BPF_ALU64|BPF_MOV|BPF_X,.dst_reg=BPF_REG_2,.src_reg=BPF_REG_10},
        {.code=BPF_ALU64|BPF_ADD|BPF_K,.dst_reg=BPF_REG_2,.imm=-4},
        {.code=BPF_ST|BPF_W|BPF_MEM,.dst_reg=BPF_REG_10,.off=-4,.imm=0},
        {.code=BPF_JMP|BPF_CALL,.imm=BPF_FUNC_map_lookup_elem},
        {.code=BPF_JMP|BPF_JEQ|BPF_K,.dst_reg=BPF_REG_0,.off=19},
        {.code=BPF_ALU64|BPF_MOV|BPF_X,.dst_reg=BPF_REG_6,.src_reg=BPF_REG_0},
        {.code=BPF_ST|BPF_W|BPF_MEM,.dst_reg=BPF_REG_10,.off=-16,.imm=0x04030201},
        {.code=BPF_ALU64|BPF_MOV|BPF_X,.dst_reg=BPF_REG_7,.src_reg=BPF_REG_10},
        {.code=BPF_ALU64|BPF_ADD|BPF_K,.dst_reg=BPF_REG_7,.imm=-16},
        {.code=BPF_LDX|BPF_W|BPF_MEM,.dst_reg=BPF_REG_8,.src_reg=BPF_REG_6,.off=offsetof(struct result,invalid)},
        {.code=BPF_JMP|BPF_JEQ|BPF_K,.dst_reg=BPF_REG_8,.off=1},
        {.code=BPF_ALU64|BPF_MOV|BPF_K,.dst_reg=BPF_REG_7,.imm=-1},
        {.code=BPF_STX|BPF_DW|BPF_MEM,.dst_reg=BPF_REG_10,.src_reg=BPF_REG_7,.off=-8},
        {.code=BPF_ALU64|BPF_MOV|BPF_X,.dst_reg=BPF_REG_1,.src_reg=BPF_REG_6},
        {.code=BPF_ALU64|BPF_MOV|BPF_K,.dst_reg=BPF_REG_2,.imm=32},
        {.code=BPF_LD|BPF_DW|BPF_IMM,.dst_reg=BPF_REG_3,.src_reg=BPF_PSEUDO_MAP_VALUE,.imm=format}, {0},
        {.code=BPF_ALU64|BPF_MOV|BPF_X,.dst_reg=BPF_REG_4,.src_reg=BPF_REG_10},
        {.code=BPF_ALU64|BPF_ADD|BPF_K,.dst_reg=BPF_REG_4,.imm=-8},
        {.code=BPF_ALU64|BPF_MOV|BPF_K,.dst_reg=BPF_REG_5,.imm=8},
        {.code=BPF_JMP|BPF_CALL,.imm=BPF_FUNC_snprintf},
        {.code=BPF_STX|BPF_W|BPF_MEM,.dst_reg=BPF_REG_6,.src_reg=BPF_REG_0,.off=offsetof(struct result,status)},
        {.code=BPF_ALU64|BPF_MOV|BPF_K,.dst_reg=BPF_REG_0,.imm=65535},
        {.code=BPF_JMP|BPF_EXIT},
        {.code=BPF_ALU64|BPF_MOV|BPF_K,.dst_reg=BPF_REG_0,.imm=0},
        {.code=BPF_JMP|BPF_EXIT},
    };
    union bpf_attr attr = {.prog_type=BPF_PROG_TYPE_SOCKET_FILTER,
        .insn_cnt=sizeof(program)/sizeof(program[0]),.insns=pointer(program),
        .license=pointer("Dual MIT/GPL"),.log_level=1,
        .log_buf=pointer(verifier_log),.log_size=sizeof(verifier_log)};
    int fd = command(BPF_PROG_LOAD, &attr);
    if (fd < 0) {
        int error = errno;
        fprintf(stderr, "BPF verifier: %.4096s\n", verifier_log);
        errno = error;
        require(0, "load standard snprintf filter");
    }
    return fd;
}
static void exchange(int map_fd, int sender, int receiver, unsigned invalid)
{
    struct result value;
    memset(&value, 0xa5, sizeof(value));
    value.invalid=invalid;
    value.status=-999;
    update(map_fd, &value);
    const unsigned char data[] = {0, 0x43, 0xff};
    require(send(sender,data,sizeof(data),MSG_DONTWAIT)==sizeof(data),"send filtered datagram");
    struct pollfd ready = {.fd=receiver,.events=POLLIN};
    require(poll(&ready,1,2000)==1 && (ready.revents&POLLIN),"filter completed without trapping kernel");
    unsigned char received[4];
    require(recv(receiver,received,sizeof(received),MSG_DONTWAIT)==sizeof(data) &&
            !memcmp(received,data,sizeof(data)),"exact packet after helper");
    lookup(map_fd,&value);
    require(value.status==8 && !strcmp(value.text,invalid?"0.0.0.0":"1.2.3.4"),
            "valid kernel read or upstream zero-filled nofault fallback");
    require(value.invalid==invalid,"input field preserved");
    for (unsigned i=0; i<sizeof(value.tail); i++)
        require(value.tail[i]==0xa5,"helper output remains bounded");
}
int main(void)
{
    int result = map(sizeof(struct result),0);
    int format = map(8,BPF_F_RDONLY_PROG);
    const char text[8] = "%pI4";
    update(format,text);
    union bpf_attr freeze = {.map_fd=(uint32_t)format};
    require(!command(BPF_MAP_FREEZE,&freeze),"freeze format for verifier");
    int program = load(result,format);
    int pair[2];
    require(!socketpair(AF_UNIX,SOCK_DGRAM|SOCK_CLOEXEC,0,pair),"socket pair");
    require(!setsockopt(pair[1],SOL_SOCKET,SO_ATTACH_BPF,&program,sizeof(program)),"attach helper program");
    require(!close(program) && !close(format),"socket retains program and format map");
    exchange(result,pair[0],pair[1],0);
    puts("bpf nofault: standard syscall, verified helper and valid kernel stack read pass");
    exchange(result,pair[0],pair[1],1);
    puts("bpf nofault: invalid kernel address uses zero-filled helper fallback without kernel trap pass");
    exchange(result,pair[0],pair[1],0);
    require(!close(pair[0]) && !close(pair[1]) && !close(result),"release descriptors and references");
    puts("bpf nofault: valid retry, exact socket payload, bounded output and descriptor cleanup pass");
    return 0;
}
