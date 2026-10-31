package org.example.bff.books;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Le formulaire « Nouveau livre » tel que l'interface l'envoie.
 */
public record CreateBookRequest(
        @NotBlank @Size(max = 200) String title,
        @NotBlank @Pattern(regexp = "^(97[89])?\\d{9}[\\dX]$", message = "ISBN invalide") String isbn,
        Long publisherId) {
}
