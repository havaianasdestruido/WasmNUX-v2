/* A freestanding 32-bit Multiboot 1 kernel. No BIOS calls after entry. */
.section .text
.code32
.align 4
.long 0x1badb002, 0, -0x1badb002
.global _start
_start:
    mov $0x3fb, %dx
    mov $3, %al
    out %al, %dx
    mov $0x3f8, %dx
    mov $5, %edi
trial:
    mov $1000000, %ecx
    mov $3, %ebx
    mov $17, %esi
    mov $'S', %al
    out %al, %dx
loop:
    imul %esi, %ebx
    add %ecx, %ebx
    xor %esi, %ebx
    dec %ecx
    jnz loop
    mov %ebx, result
    mov $'D', %al
    out %al, %dx
    dec %edi
    jnz trial
halt:
    cli
    hlt
    jmp halt
.section .result,"aw"
result: .long 0
