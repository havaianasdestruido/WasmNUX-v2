ENTRY(_start)
PHDRS { text PT_LOAD FLAGS(5); data PT_LOAD FLAGS(6); }
SECTIONS {
  . = 0x100000;
  .text : { *(.text) } :text
  . = 0x101000;
  .result : { *(.result) } :data
  /DISCARD/ : { *(.data) *(.bss) *(.note*) }
}
