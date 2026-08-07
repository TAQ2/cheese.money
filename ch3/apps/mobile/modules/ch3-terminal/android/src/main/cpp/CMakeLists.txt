cmake_minimum_required(VERSION 3.22.1)

project(ch3terminal LANGUAGES CXX)

add_library(ghostty-vt SHARED IMPORTED)
set_target_properties(
  ghostty-vt
  PROPERTIES IMPORTED_LOCATION
             "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libghostty-vt.so"
)

add_library(ch3terminal SHARED ch3_terminal_jni.cpp)

target_include_directories(
  ch3terminal
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../Vendor/libghostty-vt/include"
)

target_link_options(
  ch3terminal PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)

target_link_libraries(ch3terminal PRIVATE ghostty-vt log)
