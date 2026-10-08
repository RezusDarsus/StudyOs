package com.studyos;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import jakarta.servlet.http.HttpServletResponse;

@Controller
public class HomeController {
    @GetMapping("/") public String home(HttpServletResponse response) { response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); return "redirect:/ui/index.html"; }
}
